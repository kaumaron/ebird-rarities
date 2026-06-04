const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(express.json());

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

const EBIRD_API_KEY = process.env.EBIRD_API_KEY;
const EBIRD_DAYS_BACK = parseInt(process.env.EBIRD_DAYS_BACK || '1', 10);

// Build Discord webhook map from env vars.
// DISCORD_WEBHOOK_ALL -> all counties
// DISCORD_WEBHOOK_CAPE_MAY -> Cape May, etc.
function loadDiscordWebhooks() {
  const map = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('DISCORD_WEBHOOK_') || !value) continue;
    const suffix = key.slice('DISCORD_WEBHOOK_'.length);
    if (suffix === 'ALL') {
      map['ALL'] = value;
    } else {
      // Convert CAPE_MAY -> Cape May
      const county = suffix.split('_').map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
      map[county] = value;
    }
  }
  return map;
}

const discordWebhooks = loadDiscordWebhooks();

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
  if (!EBIRD_API_KEY) {
    throw new Error('EBIRD_API_KEY environment variable is not set');
  }

  const url = `https://api.ebird.org/v2/data/obs/${regionCode}/recent/notable`;
  const response = await axios.get(url, {
    headers: { 'X-eBirdApiToken': EBIRD_API_KEY },
    params: { back: EBIRD_DAYS_BACK, detail: 'full' },
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
    headers: { 'X-eBirdApiToken': EBIRD_API_KEY },
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

// Store new observations in database, returning only the ones actually inserted
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
  if (obs.subId) embed.url = `https://ebird.org/checklist/${obs.subId}`;

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

// Send Discord notifications — per-county webhooks + optional ALL webhook
async function sendDiscordNotifications(newObservations) {
  if (!Object.keys(discordWebhooks).length) return;

  // Group by county
  const byCounty = {};
  for (const obs of newObservations) {
    (byCounty[obs.county] = byCounty[obs.county] || []).push(obs);
  }

  // Per-county webhooks
  for (const [county, observations] of Object.entries(byCounty)) {
    const url = discordWebhooks[county];
    if (!url) continue;
    try {
      await postToDiscord(url, observations);
      console.log(`✓ Discord notified: ${county} (${observations.length} obs)`);
    } catch (err) {
      console.error(`✗ Discord failed for ${county}:`, err.message);
    }
  }

  // ALL webhook gets everything in one go
  const allUrl = discordWebhooks['ALL'];
  if (allUrl && newObservations.length > 0) {
    try {
      await postToDiscord(allUrl, newObservations);
      console.log(`✓ Discord ALL notified (${newObservations.length} obs)`);
    } catch (err) {
      console.error('✗ Discord ALL failed:', err.message);
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
app.post('/webhooks/register', (req, res) => {
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
app.get('/webhooks', (req, res) => {
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
app.delete('/webhooks/:id', (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM webhooks WHERE id = ?', [id], function(err) {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (this.changes === 0) return res.status(404).json({ error: 'Webhook not found' });
    
    res.json({ message: 'Webhook deleted', id });
  });
});

// Get recent observations
app.get('/observations', (req, res) => {
  const { county, limit = 50, hours = 24 } = req.query;

  let query = 'SELECT * FROM observations WHERE scrape_timestamp > datetime(\'now\', ?)';
  const params = [`-${hours} hours`];

  if (county) {
    query += ' AND county = ?';
    params.push(county);
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

// Observations browser UI
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NJ eBird Rarities</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #222; }
    header { background: #2d6a4f; color: white; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 1.25rem; font-weight: 600; }
    header span { font-size: 0.85rem; opacity: 0.8; }
    .controls { display: flex; flex-wrap: wrap; gap: 12px; padding: 16px 24px; background: white; border-bottom: 1px solid #ddd; align-items: flex-end; }
    .controls label { font-size: 0.8rem; color: #555; display: flex; flex-direction: column; gap: 4px; }
    .controls select, .controls input { padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; }
    .controls button { padding: 7px 16px; background: #2d6a4f; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
    .controls button:hover { background: #1b4332; }
    .controls button.secondary { background: #6c757d; }
    .controls button.secondary:hover { background: #495057; }
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
</head>
<body>
  <header>
    <h1>NJ eBird Rarities</h1>
    <span id="last-updated"></span>
  </header>
  <div class="controls">
    <label>County
      <select id="county-filter">
        <option value="">All counties</option>
      </select>
    </label>
    <label>Hours back
      <input type="number" id="hours-filter" value="24" min="1" max="720" style="width:80px">
    </label>
    <label>Max results
      <input type="number" id="limit-filter" value="200" min="1" max="1000" style="width:80px">
    </label>
    <button onclick="loadObservations()">Filter</button>
    <button class="secondary" onclick="triggerScrape()">Fetch now</button>
  </div>
  <div id="status">Loading...</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Species</th>
          <th>County</th>
          <th>Location</th>
          <th>Date</th>
          <th>Observer</th>
          <th>Count</th>
          <th>Status</th>
          <th>Notes &amp; Media</th>
        </tr>
      </thead>
      <tbody id="obs-body"></tbody>
    </table>
  </div>
  <script>
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
      const hours = document.getElementById('hours-filter').value;
      const limit = document.getElementById('limit-filter').value;
      const status = document.getElementById('status');

      status.className = '';
      status.textContent = 'Loading...';

      const params = new URLSearchParams({ hours, limit });
      if (county) params.set('county', county);

      try {
        const res = await fetch('/observations?' + params);
        const rows = await res.json();
        renderTable(rows);
        status.textContent = rows.length + ' observation' + (rows.length !== 1 ? 's' : '') + ' — last loaded ' + new Date().toLocaleTimeString();
        document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
      } catch (e) {
        status.className = 'error';
        status.textContent = 'Error loading observations: ' + e.message;
      }
    }

    function renderTable(rows) {
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

    loadCounties();
    loadObservations();
  </script>
</body>
</html>`);
});

// Manually trigger a scrape (for testing)
app.post('/scrape-now', async (req, res) => {
  res.json({ message: 'Scrape started in background' });
  runDailyUpdate().catch(console.error);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Schedule daily scrape at 6 AM
cron.schedule('0 4,10,16,22 * * *', () => {
  runDailyUpdate();
});

// Also run on startup
setTimeout(() => {
  runDailyUpdate();
}, 5000);

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
