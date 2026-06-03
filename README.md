# NJ eBird Rarities

A Node.js server that pulls notable bird observations for all 21 New Jersey counties from the eBird API, stores them in SQLite, and serves a browser UI for reviewing sightings. Optionally pushes new observations to registered webhooks.

## Requirements

- Node.js 16+
- An eBird API key — get one at https://ebird.org/api/keygen
- Docker (optional, recommended for deployment)

## Quick Start

### With Docker (recommended)

```bash
cp .env.example .env
# Add your EBIRD_API_KEY to .env
docker compose up --build -d
```

### Without Docker

```bash
cp .env.example .env
# Add your EBIRD_API_KEY to .env
npm install
npm start
```

Open **http://localhost:3000** to view the observations UI.

## Configuration

All configuration is via environment variables (copy `.env.example` to `.env`):

| Variable | Default | Description |
|---|---|---|
| `EBIRD_API_KEY` | *(required)* | Your eBird API key |
| `PORT` | `3000` | HTTP port |
| `EBIRD_DAYS_BACK` | `1` | Days back to fetch notable obs (max 30) |
| `SCRAPE_SCHEDULE` | `0 6 * * *` | Cron schedule for daily fetch |

## How It Works

1. On startup (and daily at 6 AM), the server fetches **notable observations** for each NJ county from the eBird API (`/v2/data/obs/{regionCode}/recent/notable`)
2. For each observation, it fetches the associated **checklist** (`/v2/product/checklist/view/{subId}`) to get the observer's species comment and media counts
3. New observations are stored in SQLite (duplicates are ignored)
4. Any registered webhooks are notified of new sightings

## Browser UI

Visit **http://localhost:3000** to browse observations. Features:

- Filter by county, time window, and result count
- Species common name + scientific name
- Location linked to eBird hotspot page
- Observer, date, count
- Review status badge (Confirmed / Unreviewed / Not Accepted)
- Observer's species comment
- Media counts (📷 photos, 🔊 audio, 🎥 video) with checklist link
- Map link for geolocated sightings
- **Fetch now** button to trigger an immediate scrape

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Browser UI |
| `GET` | `/observations` | Recent observations (JSON) |
| `GET` | `/counties` | List of NJ counties |
| `POST` | `/scrape-now` | Trigger immediate fetch |
| `GET` | `/health` | Health check |
| `POST` | `/webhooks/register` | Register a webhook |
| `GET` | `/webhooks` | List registered webhooks |
| `DELETE` | `/webhooks/:id` | Remove a webhook |

### GET /observations

Query params: `county`, `hours` (default 24), `limit` (default 50)

```bash
curl "http://localhost:3000/observations?county=Cape+May&hours=48"
```

### POST /webhooks/register

```bash
curl -X POST http://localhost:3000/webhooks/register \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-server.com/hook", "counties": ["Cape May", "Bergen"]}'
```

Omit `counties` to receive all counties. Webhook payload:

```json
{
  "timestamp": "2026-06-03T06:00:00Z",
  "count": 3,
  "observations": [...]
}
```

## Database Schema

SQLite database at `./ebird-webhooks.db` (or `/app/data/` in Docker).

Key fields on the `observations` table: `county`, `species`, `scientific_name`, `location`, `location_id`, `date`, `observer`, `count`, `lat`, `lng`, `status`, `sub_id`, `obs_id`, `species_comment`, `checklist_comment`, `media_photos`, `media_audio`, `media_video`.

## Troubleshooting

**No observations showing** — check that `EBIRD_API_KEY` is set and valid. Trigger a manual fetch with `POST /scrape-now` and watch the container logs.

**Port conflict** — set a different `PORT` in `.env`.

**Reset the database** — stop the container, delete `ebird-webhooks.db`, restart.

```bash
docker compose logs -f ebird-webhook
```
