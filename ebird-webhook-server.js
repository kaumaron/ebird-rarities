const express = require('express');
const session = require('express-session');
const cron = require('node-cron');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Everything below runs inside main() so it only executes after
// loadAWSSecrets() has populated process.env — session middleware and the
// Discord-webhook env seeding below both need real values, not undefined.
async function main() {
  await loadAWSSecrets();

  if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET must be set (used to sign session cookies)');
  }

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => {
  const error = req.query.error ? '<p style="color:#e05c5c;margin:0 0 12px">Incorrect password.</p>' : '';
  res.send(`<!DOCTYPE html><html><head><title>Login</title><style>
    body{font-family:sans-serif;background:#1a1a2e;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .box{background:#16213e;padding:32px;border-radius:8px;width:280px}
    h2{color:#e2e8f0;margin:0 0 20px;font-size:1.2rem}
    input{width:100%;padding:8px 10px;border-radius:4px;border:1px solid #2d3748;background:#0f3460;color:#e2e8f0;font-size:1rem;box-sizing:border-box}
    button{margin-top:12px;width:100%;padding:9px;background:#3b82f6;color:#fff;border:none;border-radius:4px;font-size:1rem;cursor:pointer}
    button:hover{background:#2563eb}
  </style></head><body><div class="box">
    <h2>eBird Admin</h2>${error}
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Password" autofocus>
      <button type="submit">Sign in</button>
    </form>
  </div></body></html>`);
});

app.post('/login', (req, res) => {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return res.redirect('/login?error=1');
  if (req.body.password === adminPassword) {
    req.session.authenticated = true;
    res.redirect('/settings');
  } else {
    res.redirect('/login?error=1');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Database setup
const dbPath = path.join(__dirname, 'data', 'ebird-webhooks.db');
const db = new sqlite3.Database(dbPath);

// Initialize database
db.run(`
  CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE NOT NULL,
    counties TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migrate observations table to use sub_id + species_code as the unique key.
// The old UNIQUE(county, species, location_id, date, observer) breaks because
// SQLite treats each NULL as distinct, causing re-inserts every run.
// We detect the old schema by reading the CREATE TABLE statement from sqlite_master.
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      county TEXT NOT NULL,
      species TEXT NOT NULL,
      species_code TEXT,
      scientific_name TEXT,
      location TEXT NOT NULL,
      location_id TEXT,
      date TEXT NOT NULL,
      observer TEXT NOT NULL,
      count INTEGER,
      lat REAL,
      lng REAL,
      reviewed INTEGER,
      valid INTEGER,
      status TEXT,
      sub_id TEXT,
      obs_id TEXT,
      species_comment TEXT,
      checklist_comment TEXT,
      media_photos INTEGER DEFAULT 0,
      media_audio INTEGER DEFAULT 0,
      media_video INTEGER DEFAULT 0,
      scrape_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sub_id, species_code)
    )
  `);

  db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='observations'`, (err, row) => {
    if (!row || !row.sql || row.sql.includes('UNIQUE(sub_id, species_code)')) return;
    console.log('Migrating observations table to new unique constraint...');
    db.run(`ALTER TABLE observations RENAME TO observations_old`);
    db.run(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        county TEXT NOT NULL,
        species TEXT NOT NULL,
        species_code TEXT,
        scientific_name TEXT,
        location TEXT NOT NULL,
        location_id TEXT,
        date TEXT NOT NULL,
        observer TEXT NOT NULL,
        count INTEGER,
        lat REAL,
        lng REAL,
        reviewed INTEGER,
        valid INTEGER,
        status TEXT,
        sub_id TEXT,
        obs_id TEXT,
        species_comment TEXT,
        checklist_comment TEXT,
        media_photos INTEGER DEFAULT 0,
        media_audio INTEGER DEFAULT 0,
        media_video INTEGER DEFAULT 0,
        scrape_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(sub_id, species_code)
      )
    `);
    db.run(`INSERT OR IGNORE INTO observations SELECT * FROM observations_old`);
    db.run(`DROP TABLE observations_old`);
    console.log('Migration complete.');
  });
});

// Secrets are loaded from AWS Secrets Manager if AWS_SECRET_NAME is set,
// then merged into process.env before anything reads them.
async function loadAWSSecrets() {
  const secretName = process.env.AWS_SECRET_NAME;
  if (!secretName) return;
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
    const secrets = JSON.parse(response.SecretString);
    Object.assign(process.env, secrets);
    console.log(`Loaded ${Object.keys(secrets).length} secrets from AWS Secrets Manager (${secretName})`);
  } catch (err) {
    console.error('Failed to load AWS secrets:', err.message);
    process.exit(1);
  }
}

// Discord webhooks are stored in the DB and managed via the UI.
// On first startup, seed from any DISCORD_WEBHOOK_* env vars so existing
// configs carry over automatically.
db.run(`
  CREATE TABLE IF NOT EXISTS discord_webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    county TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.get('SELECT COUNT(*) as count FROM discord_webhooks', (err, row) => {
  if (err || row.count > 0) return;
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('DISCORD_WEBHOOK_') || !value) continue;
    const suffix = key.slice('DISCORD_WEBHOOK_'.length);
    const county = suffix === 'ALL' ? 'ALL'
      : suffix.split('_').map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
    const name = `${county} (imported from env)`;
    db.run('INSERT INTO discord_webhooks (name, county, url) VALUES (?, ?, ?)', [name, county, value]);
  }
});

// NJ county names mapped to their eBird region codes (US-NJ-{FIPS})
const njCounties = {
  'Atlantic':    'US-NJ-001',
  'Bergen':      'US-NJ-003',
  'Burlington':  'US-NJ-005',
  'Camden':      'US-NJ-007',
  'Cape May':    'US-NJ-009',
  'Cumberland':  'US-NJ-011',
  'Essex':       'US-NJ-013',
  'Gloucester':  'US-NJ-015',
  'Hudson':      'US-NJ-017',
  'Hunterdon':   'US-NJ-019',
  'Mercer':      'US-NJ-021',
  'Middlesex':   'US-NJ-023',
  'Monmouth':    'US-NJ-025',
  'Morris':      'US-NJ-027',
  'Ocean':       'US-NJ-029',
  'Passaic':     'US-NJ-031',
  'Salem':       'US-NJ-033',
  'Somerset':    'US-NJ-035',
  'Sussex':      'US-NJ-037',
  'Union':       'US-NJ-039',
  'Warren':      'US-NJ-041'
};

// Fetch notable observations for a single county via the eBird API
async function fetchCountyNotable(county, regionCode) {
  const apiKey = process.env.EBIRD_API_KEY;
  const daysBack = parseInt(process.env.EBIRD_DAYS_BACK || '1', 10);
  if (!apiKey) throw new Error('EBIRD_API_KEY is not set');

  const url = `https://api.ebird.org/v2/data/obs/${regionCode}/recent/notable`;
  const response = await axios.get(url, {
    headers: { 'X-eBirdApiToken': apiKey },
    params: { back: daysBack, detail: 'full' },
    timeout: 15000
  });

  return response.data.map(obs => ({
    county,
    species: obs.comName,
    speciesCode: obs.speciesCode,
    scientificName: obs.sciName,
    location: obs.locName,
    locationId: obs.locId,
    date: obs.obsDt,
    observer: obs.userDisplayName || 'Unknown',
    count: obs.howMany || null,
    lat: obs.lat,
    lng: obs.lng,
    reviewed: obs.obsReviewed,
    valid: obs.obsValid,
    status: obs.obsReviewed ? (obs.obsValid ? 'Confirmed' : 'Not Accepted') : 'Unreviewed',
    subId: obs.subId || null
  }));
}

// Fetch notable observations for all NJ counties
async function scrapeAllCounties() {
  const allObservations = [];

  for (const [county, regionCode] of Object.entries(njCounties)) {
    console.log(`Fetching ${county} (${regionCode})...`);
    try {
      const observations = await fetchCountyNotable(county, regionCode);
      allObservations.push(...observations);
      console.log(`✓ ${county}: ${observations.length} notable observations`);
    } catch (error) {
      console.error(`✗ Error fetching ${county}:`, error.message);
    }

    // Stay within eBird API rate limits
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return allObservations;
}

// Fetch a single checklist's details
async function fetchChecklistDetails(subId) {
  const response = await axios.get(`https://api.ebird.org/v2/product/checklist/view/${subId}`, {
    headers: { 'X-eBirdApiToken': process.env.EBIRD_API_KEY },
    timeout: 15000
  });
  return response.data;
}

// Enrich observations with species comments and media counts from their checklists.
// Groups by subId so each checklist is only fetched once.
async function enrichWithChecklistDetails(observations) {
  const subIds = [...new Set(observations.map(o => o.subId).filter(Boolean))];
  const cache = {};

  for (const subId of subIds) {
    try {
      cache[subId] = await fetchChecklistDetails(subId);
      console.log(`  checklist ${subId}: ok`);
    } catch (err) {
      console.error(`  checklist ${subId}: ${err.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  return observations.map(obs => {
    const checklist = obs.subId ? cache[obs.subId] : null;
    if (!checklist) return obs;

    const entry = checklist.obs?.find(o => o.speciesCode === obs.speciesCode);
    return {
      ...obs,
      speciesComment: entry?.comments || null,
      checklistComment: checklist.comments || null,
      obsId: entry?.obsId || null,
      mediaPhotos: entry?.mediaCounts?.P || 0,
      mediaAudio: entry?.mediaCounts?.A || 0,
      mediaVideo: entry?.mediaCounts?.V || 0
    };
  });
}

// Store new observations in database, returning only the ones actually inserted.
// Observations already in the DB get their media counts refreshed in place
// (e.g. photos added to a checklist after the initial scrape) without being
// treated as new for notification purposes.
async function storeObservations(observations) {
  if (observations.length === 0) return [];

  // Pre-query which (sub_id, species_code) pairs already exist
  const subIds = [...new Set(observations.map(o => o.subId).filter(Boolean))];
  const existing = await new Promise((resolve, reject) => {
    if (subIds.length === 0) return resolve(new Set());
    const placeholders = subIds.map(() => '?').join(',');
    db.all(
      `SELECT sub_id, species_code FROM observations WHERE sub_id IN (${placeholders})`,
      subIds,
      (err, rows) => {
        if (err) return reject(err);
        resolve(new Set(rows.map(r => `${r.sub_id}:${r.species_code}`)));
      }
    );
  });

  const newObservations = observations.filter(o => !existing.has(`${o.subId}:${o.speciesCode}`));
  const existingObservations = observations.filter(o => existing.has(`${o.subId}:${o.speciesCode}`));

  if (existingObservations.length > 0) {
    await new Promise((resolve, reject) => {
      const stmt = db.prepare(`
        UPDATE observations SET media_photos = ?, media_audio = ?, media_video = ?
        WHERE sub_id = ? AND species_code = ?
      `);
      existingObservations.forEach(obs => {
        stmt.run(
          [obs.mediaPhotos || 0, obs.mediaAudio || 0, obs.mediaVideo || 0, obs.subId, obs.speciesCode],
          err => { if (err) console.error('DB update error:', err); }
        );
      });
      stmt.finalize(err => { if (err) reject(err); else resolve(); });
    });
  }

  if (newObservations.length === 0) return [];

  await new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO observations
      (county, species, species_code, scientific_name, location, location_id, date, observer,
       count, lat, lng, reviewed, valid, status,
       sub_id, obs_id, species_comment, checklist_comment, media_photos, media_audio, media_video)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    newObservations.forEach(obs => {
      stmt.run(
        [obs.county, obs.species, obs.speciesCode || null, obs.scientificName,
         obs.location, obs.locationId, obs.date, obs.observer,
         obs.count, obs.lat, obs.lng, obs.reviewed ? 1 : 0, obs.valid ? 1 : 0, obs.status,
         obs.subId || null, obs.obsId || null, obs.speciesComment || null, obs.checklistComment || null,
         obs.mediaPhotos || 0, obs.mediaAudio || 0, obs.mediaVideo || 0],
        err => { if (err) console.error('DB insert error:', err); }
      );
    });

    stmt.finalize(err => {
      if (err) reject(err);
      else resolve();
    });
  });

  return newObservations;
}

// Get webhooks that should receive this update
function getRelevantWebhooks(counties) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM webhooks', (err, rows) => {
      if (err) return reject(err);
      
      const relevant = rows.filter(webhook => {
        if (!webhook.counties) return true; // Empty counties = all updates
        const webhookCounties = webhook.counties.split(',').map(c => c.trim());
        return counties.some(c => webhookCounties.includes(c));
      });

      resolve(relevant);
    });
  });
}

// Send webhook notifications
async function sendWebhookNotifications(observations) {
  const counties = [...new Set(observations.map(o => o.county))];
  const webhooks = await getRelevantWebhooks(counties);

  const failedWebhooks = [];

  for (const webhook of webhooks) {
    try {
      await axios.post(webhook.url, {
        timestamp: new Date().toISOString(),
        observations,
        count: observations.length
      }, {
        timeout: 5000
      });
      console.log(`✓ Webhook notified: ${webhook.url}`);
    } catch (error) {
      console.error(`✗ Webhook failed: ${webhook.url}`, error.message);
      failedWebhooks.push(webhook.id);
    }
  }

  // Optionally remove webhooks that fail multiple times
  return failedWebhooks;
}

// Build a Discord embed for a single observation
function buildEmbed(obs) {
  const colors = { 'Confirmed': 0x2d6a4f, 'Unreviewed': 0xf0a500, 'Not Accepted': 0xc0392b };
  const color = colors[obs.status] || 0x888888;

  const fields = [
    { name: 'County',   value: obs.county,            inline: true },
    { name: 'Location', value: obs.location,           inline: true },
    { name: 'Date',     value: obs.date,               inline: true },
    { name: 'Observer', value: obs.observer,           inline: true },
    { name: 'Count',    value: obs.count != null ? String(obs.count) : '—', inline: true },
    { name: 'Status',   value: obs.status || 'Unknown', inline: true },
  ];

  const mediaParts = [];
  if (obs.mediaPhotos > 0) mediaParts.push(`📷 ${obs.mediaPhotos}`);
  if (obs.mediaAudio  > 0) mediaParts.push(`🔊 ${obs.mediaAudio}`);
  if (obs.mediaVideo  > 0) mediaParts.push(`🎥 ${obs.mediaVideo}`);
  if (mediaParts.length)   fields.push({ name: 'Media', value: mediaParts.join('  '), inline: true });

  const embed = { title: obs.species, color, fields };
  if (obs.scientificName) embed.description = `*${obs.scientificName}*`;
  if (obs.speciesComment) embed.description = (embed.description ? embed.description + '\n' : '') + obs.speciesComment;
  if (obs.subId) embed.url = `https://ebird.org/checklist/${obs.subId}${obs.obsId ? '#' + obs.obsId : ''}`;

  return embed;
}

// Post observations to Discord, batching up to 10 embeds per message
async function postToDiscord(webhookUrl, observations) {
  const BATCH = 10;
  for (let i = 0; i < observations.length; i += BATCH) {
    const batch = observations.slice(i, i + BATCH);
    await axios.post(webhookUrl, {
      username: 'NJ eBird Rarities',
      embeds: batch.map(buildEmbed)
    }, { timeout: 10000 });
    if (i + BATCH < observations.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

// Send Discord notifications — queries DB for webhooks each run so UI changes
// take effect immediately. Multiple webhooks per county are each posted to independently.
async function sendDiscordNotifications(newObservations) {
  const webhooks = await new Promise((resolve, reject) => {
    db.all('SELECT * FROM discord_webhooks', (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
  if (!webhooks.length) return;

  const byCounty = {};
  for (const obs of newObservations) {
    (byCounty[obs.county] = byCounty[obs.county] || []).push(obs);
  }

  for (const webhook of webhooks) {
    const observations = webhook.county === 'ALL' ? newObservations : (byCounty[webhook.county] || []);
    if (!observations.length) continue;
    try {
      await postToDiscord(webhook.url, observations);
      console.log(`✓ Discord [${webhook.name}]: ${observations.length} obs`);
    } catch (err) {
      console.error(`✗ Discord [${webhook.name}]: ${err.message}`);
    }
  }
}

let scrapeRunning = false;

// Main scrape and notify function
async function runDailyUpdate() {
  if (scrapeRunning) {
    console.log('Scrape already in progress, skipping.');
    return;
  }
  scrapeRunning = true;
  console.log(`\n[${new Date().toISOString()}] Starting daily eBird alert scrape...`);
  
  try {
    const observations = await scrapeAllCounties();
    console.log(`Found ${observations.length} observations — fetching checklist details...`);

    const enriched = await enrichWithChecklistDetails(observations);
    const newObs = await storeObservations(enriched);
    console.log(`Stored ${newObs.length} new observations`);

    if (newObs.length > 0) {
      await sendWebhookNotifications(newObs);
      await sendDiscordNotifications(newObs);
    }
  } catch (error) {
    console.error('Error during daily update:', error);
  } finally {
    scrapeRunning = false;
  }
}

// REST API Endpoints

// Register a webhook
app.post('/webhooks/register', requireAuth, (req, res) => {
  const { url, counties } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL required' });
  }

  const countyString = counties ? counties.join(',') : null;

  db.run(
    'INSERT OR REPLACE INTO webhooks (url, counties) VALUES (?, ?)',
    [url, countyString],
    function(err) {
      if (err) {
        return res.status(400).json({ error: 'Failed to register webhook' });
      }
      res.json({ 
        message: 'Webhook registered',
        id: this.lastID,
        url,
        counties: counties || 'all'
      });
    }
  );
});

// List all registered webhooks
app.get('/webhooks', requireAuth, (req, res) => {
  db.all('SELECT id, url, counties, created_at FROM webhooks', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    
    const formatted = rows.map(r => ({
      id: r.id,
      url: r.url,
      counties: r.counties ? r.counties.split(',').map(c => c.trim()) : ['all'],
      created_at: r.created_at
    }));

    res.json(formatted);
  });
});

// Remove a webhook
app.delete('/webhooks/:id', requireAuth, (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM webhooks WHERE id = ?', [id], function(err) {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (this.changes === 0) return res.status(404).json({ error: 'Webhook not found' });
    
    res.json({ message: 'Webhook deleted', id });
  });
});

// Get recent observations
const MEDIA_COLUMNS = { photo: 'media_photos', audio: 'media_audio', video: 'media_video' };

app.get('/observations', (req, res) => {
  const { county, limit = 50, hours = 24, species, media } = req.query;

  let query = 'SELECT * FROM observations WHERE scrape_timestamp > datetime(\'now\', ?)';
  const params = [`-${hours} hours`];

  if (county) {
    query += ' AND county = ?';
    params.push(county);
  }

  if (species) {
    const speciesList = Array.isArray(species) ? species : [species];
    if (speciesList.length > 0) {
      query += ` AND species IN (${speciesList.map(() => '?').join(',')})`;
      params.push(...speciesList);
    }
  }

  if (media) {
    const mediaList = (Array.isArray(media) ? media : [media]).filter(m => MEDIA_COLUMNS[m]);
    if (mediaList.length > 0) {
      query += ` AND (${mediaList.map(m => `${MEDIA_COLUMNS[m]} > 0`).join(' OR ')})`;
    }
  }

  query += ' ORDER BY scrape_timestamp DESC LIMIT ?';
  params.push(parseInt(limit));

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
});

// Get list of counties
app.get('/counties', (req, res) => {
  res.json(Object.keys(njCounties).sort());
});

// Get list of distinct species currently in the database
app.get('/species', (req, res) => {
  db.all('SELECT DISTINCT species FROM observations ORDER BY species', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows.map(r => r.species));
  });
});

// List Discord webhooks
app.get('/discord-webhooks', requireAuth, (req, res) => {
  db.all('SELECT * FROM discord_webhooks ORDER BY county, name', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
});

// Add a Discord webhook
app.post('/discord-webhooks', requireAuth, (req, res) => {
  const { name, county, url } = req.body;
  if (!name || !county || !url) return res.status(400).json({ error: 'name, county, and url are required' });
  db.run(
    'INSERT INTO discord_webhooks (name, county, url) VALUES (?, ?, ?)',
    [name, county, url],
    function(err) {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ id: this.lastID, name, county, url });
    }
  );
});

// Delete a Discord webhook
app.delete('/discord-webhooks/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM discord_webhooks WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (this.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted', id: req.params.id });
  });
});

// Shared header/nav HTML
function pageShell(title, activeHref, bodyHtml, authenticated) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — NJ eBird Rarities</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #222; }
    header { background: #2d6a4f; color: white; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 1.25rem; font-weight: 600; }
    header h1 a { color: inherit; text-decoration: none; }
    header nav { margin-left: auto; display: flex; gap: 8px; }
    header nav a { color: rgba(255,255,255,0.85); text-decoration: none; font-size: 0.85rem; padding: 4px 12px; border: 1px solid rgba(255,255,255,0.4); border-radius: 4px; }
    header nav a:hover, header nav a.active { background: rgba(255,255,255,0.2); color: white; }
  </style>
</head>
<body>
  <header>
    <h1><a href="/">NJ eBird Rarities</a></h1>
    <span id="last-updated" style="font-size:0.8rem;opacity:0.7;margin-left:12px"></span>
    <nav>
      <a href="/" ${activeHref === '/' ? 'class="active"' : ''}>Observations</a>
      ${authenticated ? `<a href="/settings" ${activeHref === '/settings' ? 'class="active"' : ''}>Discord Webhooks</a>` : ''}
    </nav>
    ${authenticated ? `<form method="POST" action="/logout" style="margin:0"><button type="submit" style="background:none;border:1px solid rgba(255,255,255,0.3);color:#e2e8f0;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:0.8rem">Logout</button></form>` : ''}
  </header>
  ${bodyHtml}
</body>
</html>`;
}

// Discord Webhooks settings page
app.get('/settings', requireAuth, async (req, res) => {
  res.send(pageShell('Discord Webhooks', '/settings', `
  <style>
    .page { max-width: 900px; margin: 32px auto; padding: 0 24px; }
    h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 16px; color: #2d6a4f; }
    .add-form { background: white; border-radius: 6px; padding: 20px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .add-form .fields { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
    .add-form label { font-size: 0.8rem; color: #555; display: flex; flex-direction: column; gap: 4px; }
    .add-form input, .add-form select { padding: 7px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; }
    .add-form input.url-input { width: 340px; }
    .add-form button { padding: 7px 20px; background: #2d6a4f; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
    .add-form button:hover { background: #1b4332; }
    #form-status { margin-top: 10px; font-size: 0.85rem; }
    #form-status.error { color: #c0392b; }
    #form-status.ok { color: #2d6a4f; }
    .wh-list { background: white; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); overflow: hidden; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    thead th { background: #2d6a4f; color: white; text-align: left; padding: 10px 14px; }
    tbody tr { border-bottom: 1px solid #eee; }
    tbody tr:hover { background: #f9f9f9; }
    td { padding: 10px 14px; vertical-align: middle; }
    .url-cell { font-family: monospace; font-size: 0.78rem; color: #555; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .county-badge { background: #e8f5e9; color: #1b4332; padding: 2px 10px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; }
    .county-badge.all { background: #e3f2fd; color: #0d47a1; }
    .btn-delete { background: none; border: 1px solid #dc3545; color: #dc3545; padding: 3px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
    .btn-delete:hover { background: #dc3545; color: white; }
    .empty { padding: 32px; text-align: center; color: #888; }
  </style>
  <div class="page">
    <h2>Add Webhook</h2>
    <div class="add-form">
      <div class="fields">
        <label>Name / Description
          <input id="wh-name" type="text" placeholder="e.g. NJ Birders #essex" style="width:200px">
        </label>
        <label>County
          <select id="wh-county">
            <option value="ALL">ALL counties</option>
          </select>
        </label>
        <label>Discord Webhook URL
          <input id="wh-url" type="url" class="url-input" placeholder="https://discord.com/api/webhooks/...">
        </label>
        <button onclick="addWebhook()">Add</button>
      </div>
      <div id="form-status"></div>
    </div>

    <h2>Configured Webhooks</h2>
    <div class="wh-list">
      <table>
        <thead><tr><th>Name</th><th>County</th><th>URL</th><th></th></tr></thead>
        <tbody id="wh-tbody"><tr><td colspan="4" class="empty">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
  <script>
    function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    async function loadCounties() {
      const counties = await (await fetch('/counties')).json();
      const sel = document.getElementById('wh-county');
      counties.forEach(c => {
        const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o);
      });
    }

    async function loadWebhooks() {
      const rows = await (await fetch('/discord-webhooks')).json();
      const tbody = document.getElementById('wh-tbody');
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty">No webhooks configured yet.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(w =>
        '<tr>' +
        '<td>' + esc(w.name) + '</td>' +
        '<td><span class="county-badge' + (w.county==='ALL'?' all':'') + '">' + esc(w.county) + '</span></td>' +
        '<td class="url-cell" title="' + esc(w.url) + '">' + esc(w.url) + '</td>' +
        '<td><button class="btn-delete" onclick="deleteWebhook(' + w.id + ')">Delete</button></td>' +
        '</tr>'
      ).join('');
    }

    async function addWebhook() {
      const name   = document.getElementById('wh-name').value.trim();
      const county = document.getElementById('wh-county').value;
      const url    = document.getElementById('wh-url').value.trim();
      const status = document.getElementById('form-status');
      if (!name || !url) { status.className='error'; status.textContent='Name and URL are required.'; return; }
      const res = await fetch('/discord-webhooks', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name, county, url })
      });
      if (res.ok) {
        document.getElementById('wh-name').value = '';
        document.getElementById('wh-url').value = '';
        status.className='ok'; status.textContent='Webhook added.';
        setTimeout(() => status.textContent='', 3000);
        loadWebhooks();
      } else {
        status.className='error'; status.textContent='Failed to add webhook.';
      }
    }

    async function deleteWebhook(id) {
      if (!confirm('Delete this webhook?')) return;
      await fetch('/discord-webhooks/' + id, { method: 'DELETE' });
      loadWebhooks();
    }

    loadCounties();
    loadWebhooks();
  </script>`, true));
});

// Observations browser UI
app.get('/', (req, res) => {
  const authenticated = !!req.session.authenticated;
  res.send(pageShell('Observations', '/', `
  <style>
    .controls { display: flex; flex-wrap: wrap; gap: 12px; padding: 16px 24px; background: white; border-bottom: 1px solid #ddd; align-items: flex-end; }
    .controls label { font-size: 0.8rem; color: #555; display: flex; flex-direction: column; gap: 4px; }
    .controls select, .controls input { padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; }
    .controls button { padding: 7px 16px; background: #2d6a4f; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
    .controls button:hover { background: #1b4332; }
    .controls button.secondary { background: #6c757d; }
    .controls button.secondary:hover { background: #495057; }
    .species-filter { position: relative; }
    .species-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; max-width: 260px; }
    .species-tag { display: inline-flex; align-items: center; gap: 4px; background: #e8f5e9; color: #1b4332; padding: 2px 6px 2px 10px; border-radius: 10px; font-size: 0.78rem; }
    .species-tag button { background: none; border: none; color: #1b4332; cursor: pointer; font-size: 0.9rem; line-height: 1; padding: 0 2px; }
    .species-tag button:hover { color: #c0392b; }
    .media-toggle-group { display: flex; gap: 10px; padding: 6px 0; }
    .media-toggle-group label { flex-direction: row; align-items: center; gap: 4px; font-size: 0.85rem; color: #333; }
    .media-toggle-group input { padding: 0; }
    #status { padding: 10px 24px; font-size: 0.85rem; color: #555; background: white; border-bottom: 1px solid #eee; }
    #status.error { color: #c0392b; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    thead th { background: #2d6a4f; color: white; text-align: left; padding: 10px 12px; position: sticky; top: 0; white-space: nowrap; }
    tbody tr { background: white; border-bottom: 1px solid #eee; }
    tbody tr:hover { background: #f0faf5; }
    td { padding: 9px 12px; vertical-align: top; }
    td.species { font-weight: 600; }
    td.sci { font-style: italic; color: #555; font-size: 0.8rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; font-weight: 500; }
    .badge.confirmed { background: #d4edda; color: #155724; }
    .badge.unreviewed { background: #fff3cd; color: #856404; }
    .badge.not-accepted { background: #f8d7da; color: #721c24; }
    .empty { text-align: center; padding: 48px; color: #888; }
    .table-wrap { overflow-x: auto; }
    a.map-link { color: #2d6a4f; text-decoration: none; font-size: 0.8rem; }
    a.map-link:hover { text-decoration: underline; }
    .comment { font-size: 0.8rem; color: #444; margin-top: 4px; font-style: italic; max-width: 300px; }
    .media-links { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
    .media-links a { font-size: 0.75rem; color: #2d6a4f; text-decoration: none; background: #e8f5e9; padding: 1px 6px; border-radius: 10px; }
    .media-links a:hover { background: #c8e6c9; }
  </style>
  <div class="controls">
    <label>County
      <select id="county-filter">
        <option value="">All counties</option>
      </select>
    </label>
    <label>Time back
      <div style="display:flex; gap:4px">
        <input type="number" id="time-filter" value="24" min="1" style="width:70px">
        <select id="time-unit">
          <option value="hours">Hours</option>
          <option value="days">Days</option>
        </select>
      </div>
    </label>
    <label>Max results
      <input type="number" id="limit-filter" value="200" min="1" max="1000" style="width:80px">
    </label>
    <label class="species-filter">Species
      <input type="text" id="species-input" list="species-list" placeholder="Type to add a species..." style="width:220px">
      <datalist id="species-list"></datalist>
      <div class="species-tags" id="species-tags"></div>
    </label>
    <label>Media
      <div class="media-toggle-group">
        <label><input type="checkbox" class="media-filter" value="photo"> 📷 Photo</label>
        <label><input type="checkbox" class="media-filter" value="audio"> 🔊 Audio</label>
        <label><input type="checkbox" class="media-filter" value="video"> 🎥 Video</label>
      </div>
    </label>
    <button onclick="loadObservations()">Filter</button>
    ${authenticated ? `<button class="secondary" onclick="triggerScrape()">Fetch now</button>` : ''}
  </div>
  <div id="status">Loading...</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th data-col="species">Species</th>
          <th data-col="county">County</th>
          <th>Location</th>
          <th data-col="date">Date</th>
          <th data-col="observer">Observer</th>
          <th data-col="count">Count</th>
          <th data-col="status">Status</th>
          <th>Notes &amp; Media</th>
        </tr>
      </thead>
      <tbody id="obs-body"></tbody>
    </table>
  </div>
  <script>
    let allRows = [];
    let sortCol = 'date';
    let sortAsc = false;
    let allSpecies = [];
    let selectedSpecies = [];

    async function loadSpeciesList() {
      const res = await fetch('/species');
      allSpecies = await res.json();
      const list = document.getElementById('species-list');
      list.innerHTML = allSpecies.map(s => '<option value="' + escHtml(s) + '">').join('');
    }

    function renderSpeciesTags() {
      const container = document.getElementById('species-tags');
      container.innerHTML = selectedSpecies.map((s, i) =>
        '<span class="species-tag">' + escHtml(s) +
        '<button type="button" onclick="removeSpecies(' + i + ')" aria-label="Remove">&times;</button></span>'
      ).join('');
    }

    function addSpeciesFromInput() {
      const input = document.getElementById('species-input');
      const val = input.value.trim();
      if (!val) return;
      const match = allSpecies.find(s => s.toLowerCase() === val.toLowerCase());
      if (match && !selectedSpecies.includes(match)) {
        selectedSpecies.push(match);
        renderSpeciesTags();
      }
      input.value = '';
    }

    function removeSpecies(i) {
      selectedSpecies.splice(i, 1);
      renderSpeciesTags();
    }

    function applyFiltersFromUrl() {
      const params = new URLSearchParams(window.location.search);
      if (params.has('county')) document.getElementById('county-filter').value = params.get('county');
      if (params.has('hours')) {
        const hours = parseInt(params.get('hours'), 10);
        if (hours % 24 === 0) {
          document.getElementById('time-filter').value = hours / 24;
          document.getElementById('time-unit').value = 'days';
        } else {
          document.getElementById('time-filter').value = hours;
          document.getElementById('time-unit').value = 'hours';
        }
      }
      if (params.has('limit')) document.getElementById('limit-filter').value = params.get('limit');
      selectedSpecies = params.getAll('species');
      renderSpeciesTags();
      const selectedMedia = params.getAll('media');
      document.querySelectorAll('.media-filter').forEach(cb => {
        cb.checked = selectedMedia.includes(cb.value);
      });
    }

    document.querySelector('thead tr').addEventListener('click', e => {
      const th = e.target.closest('th[data-col]');
      if (!th) return;
      const col = th.dataset.col;
      if (sortCol === col) {
        sortAsc = !sortAsc;
      } else {
        sortCol = col;
        sortAsc = true;
      }
      updateSortIndicators();
      renderTable(allRows);
    });

    function updateSortIndicators() {
      document.querySelectorAll('thead th').forEach(th => {
        th.style.cursor = th.dataset.col ? 'pointer' : '';
        const base = th.textContent.replace(/ [▲▼]$/, '');
        th.textContent = th.dataset.col === sortCol
          ? base + (sortAsc ? ' ▲' : ' ▼')
          : base;
      });
    }

    async function loadCounties() {
      const res = await fetch('/counties');
      const counties = await res.json();
      const sel = document.getElementById('county-filter');
      counties.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        sel.appendChild(opt);
      });
    }

    async function loadObservations() {
      const county = document.getElementById('county-filter').value;
      const timeValue = document.getElementById('time-filter').value;
      const timeUnit = document.getElementById('time-unit').value;
      const hours = timeUnit === 'days' ? timeValue * 24 : timeValue;
      const limit = document.getElementById('limit-filter').value;
      const status = document.getElementById('status');

      status.className = '';
      status.textContent = 'Loading...';

      const params = new URLSearchParams({ hours, limit });
      if (county) params.set('county', county);
      selectedSpecies.forEach(s => params.append('species', s));
      document.querySelectorAll('.media-filter:checked').forEach(cb => params.append('media', cb.value));

      history.replaceState(null, '', window.location.pathname + '?' + params.toString());

      try {
        const res = await fetch('/observations?' + params);
        allRows = await res.json();
        updateSortIndicators();
        renderTable(allRows);
        status.textContent = allRows.length + ' observation' + (allRows.length !== 1 ? 's' : '') + ' — last loaded ' + new Date().toLocaleTimeString();
        document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
      } catch (e) {
        status.className = 'error';
        status.textContent = 'Error loading observations: ' + e.message;
      }
    }

    function renderTable(rows) {
      const sorted = [...rows].sort((a, b) => {
        let av = a[sortCol], bv = b[sortCol];
        if (sortCol === 'count') { av = av ?? -1; bv = bv ?? -1; }
        else { av = (av || '').toLowerCase(); bv = (bv || '').toLowerCase(); }
        return (av < bv ? -1 : av > bv ? 1 : 0) * (sortAsc ? 1 : -1);
      });
      rows = sorted;
      const tbody = document.getElementById('obs-body');
      if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty">No observations found for the selected filters.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(r => {
        const badgeClass = r.status === 'Confirmed' ? 'confirmed' : r.status === 'Unreviewed' ? 'unreviewed' : 'not-accepted';
        const mapLink = r.lat && r.lng
          ? '<br><a class="map-link" href="https://www.google.com/maps?q=' + r.lat + ',' + r.lng + '" target="_blank">map</a>'
          : '';
        const ebirdLink = r.location_id
          ? '<a href="https://ebird.org/hotspot/' + r.location_id + '" target="_blank">' + escHtml(r.location) + '</a>'
          : escHtml(r.location);

        const comment = r.species_comment
          ? '<div class="comment">' + escHtml(r.species_comment) + '</div>'
          : '';

        const mediaLinks = [];
        if (r.sub_id) {
          const checklistUrl = 'https://ebird.org/checklist/' + r.sub_id;
          const obsId = r.obs_id;
          if (r.media_photos > 0) mediaLinks.push('📷 ' + r.media_photos);
          if (r.media_audio > 0) mediaLinks.push('🔊 ' + r.media_audio);
          if (r.media_video > 0) mediaLinks.push('🎥 ' + r.media_video);
          mediaLinks.push('<a href="' + checklistUrl + '" target="_blank">checklist</a>');
        }
        const mediaCell = mediaLinks.length
          ? '<div class="media-links">' + mediaLinks.join('') + '</div>'
          : '';

        return '<tr>' +
          '<td class="species">' + escHtml(r.species) + '<br><span class="sci">' + escHtml(r.scientific_name || '') + '</span></td>' +
          '<td>' + escHtml(r.county) + '</td>' +
          '<td>' + ebirdLink + mapLink + '</td>' +
          '<td>' + escHtml(r.date) + '</td>' +
          '<td>' + escHtml(r.observer) + '</td>' +
          '<td>' + (r.count != null ? r.count : '—') + '</td>' +
          '<td><span class="badge ' + badgeClass + '">' + escHtml(r.status) + '</span></td>' +
          '<td>' + comment + mediaCell + '</td>' +
          '</tr>';
      }).join('');
    }

    function escHtml(str) {
      return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    async function triggerScrape() {
      const status = document.getElementById('status');
      status.textContent = 'Fetching fresh data from eBird...';
      try {
        await fetch('/scrape-now', { method: 'POST' });
        status.textContent = 'Fetch started — reloading in 30 seconds...';
        setTimeout(loadObservations, 30000);
      } catch (e) {
        status.className = 'error';
        status.textContent = 'Error triggering fetch: ' + e.message;
      }
    }

    document.getElementById('species-input').addEventListener('change', addSpeciesFromInput);
    document.getElementById('species-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addSpeciesFromInput(); }
    });

    (async function init() {
      await Promise.all([loadCounties(), loadSpeciesList()]);
      applyFiltersFromUrl();
      loadObservations();
    })();
  </script>`, !!req.session.authenticated));
});

// Manually trigger a scrape (for testing)
app.post('/scrape-now', requireAuth, async (req, res) => {
  res.json({ message: 'Scrape started in background' });
  runDailyUpdate().catch(console.error);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Schedule daily scrape at 6 AM
cron.schedule('0 * * * *', () => {
  runDailyUpdate();
});

// Run startup scrape (secrets are already loaded at this point)
setTimeout(() => runDailyUpdate(), 5000);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`eBird webhook server listening on port ${PORT}`);
  console.log(`Webhook registration: POST /webhooks/register`);
  console.log(`List webhooks: GET /webhooks`);
  console.log(`Get observations: GET /observations`);
  console.log(`Get counties: GET /counties`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
}

main().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
