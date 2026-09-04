# NJ eBird Rarities

A Node.js server that pulls notable bird observations for all 21 New Jersey counties from the eBird API hourly, stores them in SQLite, and serves a browser UI for reviewing sightings. Pushes new observations to per-county Discord channels.

## Requirements

- Node.js 16+
- An eBird API key — get one at https://ebird.org/api/keygen
- Docker (recommended)

## Quick Start (local)

```bash
cp .env.example .env
# Fill in EBIRD_API_KEY and ADMIN_PASSWORD at minimum
docker compose up --build -d
```

Open **http://localhost:3000** to view observations. The admin panel is at **http://localhost:3000/settings** (requires login).

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and fill in values.

| Variable | Default | Description |
|---|---|---|
| `EBIRD_API_KEY` | *(required)* | Your eBird API key |
| `ADMIN_PASSWORD` | *(required)* | Password for the `/settings` admin panel |
| `SESSION_SECRET` | *(required)* | Random string for signing session cookies |
| `PORT` | `3000` | HTTP port |
| `EBIRD_DAYS_BACK` | `1` | Days back to fetch notable obs (1–30) |
| `SCRAPE_SCHEDULE` | `0 * * * *` | Cron schedule (default: hourly) |
| `DISCORD_WEBHOOK_<COUNTY>` | | Per-county Discord webhook URLs (see below) |

### Discord Webhooks

Webhooks can be managed via the `/settings` UI or seeded from environment variables on first startup. County names use underscores and uppercase:

```
DISCORD_WEBHOOK_CAPE_MAY=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_BERGEN=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_ALL=https://discord.com/api/webhooks/...   # catch-all
```

## AWS Deployment (EC2 + ECR)

### First-time setup

1. Push image to ECR:
```bash
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  <account-id>.dkr.ecr.us-east-1.amazonaws.com

docker build --platform linux/amd64 -t <account-id>.dkr.ecr.us-east-1.amazonaws.com/ebird-rarities:latest .
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/ebird-rarities:latest
```

2. Store credentials in AWS Secrets Manager as a JSON object:
```json
{
  "EBIRD_API_KEY": "...",
  "ADMIN_PASSWORD": "...",
  "SESSION_SECRET": "..."
}
```

3. Attach an IAM instance profile to your EC2 with:
   - `AmazonEC2ContainerRegistryReadOnly`
   - `secretsmanager:GetSecretValue` on your secret ARN

4. On the EC2 instance:
```bash
mkdir -p ~/ebird-data

docker run -d \
  --name ebird-rarities \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ~/ebird-data:/app/data \
  -e AWS_SECRET_NAME=ebird-rarities \
  -e AWS_REGION=us-east-1 \
  <account-id>.dkr.ecr.us-east-1.amazonaws.com/ebird-rarities:latest
```

When `AWS_SECRET_NAME` is set, all credentials are loaded from Secrets Manager at startup — no `.env` file needed on the server.

### Redeploying

```bash
# Locally: rebuild and push
docker build --platform linux/amd64 -t <account-id>.dkr.ecr.us-east-1.amazonaws.com/ebird-rarities:latest .
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/ebird-rarities:latest

# On EC2: pull and restart
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  <account-id>.dkr.ecr.us-east-1.amazonaws.com

docker pull <account-id>.dkr.ecr.us-east-1.amazonaws.com/ebird-rarities:latest
docker stop ebird-rarities && docker rm ebird-rarities
docker run -d \
  --name ebird-rarities \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ~/ebird-data:/app/data \
  -e AWS_SECRET_NAME=ebird-rarities \
  -e AWS_REGION=us-east-1 \
  <account-id>.dkr.ecr.us-east-1.amazonaws.com/ebird-rarities:latest
```

### HTTPS with Nginx + Let's Encrypt

```bash
sudo yum install -y nginx certbot python3-certbot-nginx

sudo tee /etc/nginx/conf.d/njbirds.athenedyne.com.conf > /dev/null <<'NGINX'
server {
    listen 80;
    server_name njbirds.athenedyne.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX

sudo nginx -t && sudo systemctl enable nginx --now
sudo certbot --nginx -d njbirds.athenedyne.com --non-interactive --agree-tos -m your@email.com
```

Certbot installs an auto-renewal cron job. Cert expires every 90 days and renews automatically.

## How It Works

1. On startup and hourly, the server fetches **notable observations** for each NJ county via the eBird API
2. For each observation, it fetches the associated **checklist** to get the observer's species comment and media counts
3. New observations are stored in SQLite — duplicates are ignored via `UNIQUE(sub_id, species_code)`
4. Registered Discord webhooks are notified of new sightings with rich embeds, batched by county

## Browser UI

- **`/`** — Observations table, filterable by county/time/limit. Public.
- **`/settings`** — Discord webhook management. Requires login.
- **`/login`** — Password login for the admin panel.

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | — | Observations UI |
| `GET` | `/observations` | — | Observations JSON |
| `GET` | `/counties` | — | NJ county list |
| `GET` | `/health` | — | Health check |
| `POST` | `/scrape-now` | — | Trigger immediate fetch |
| `GET` | `/settings` | ✓ | Discord webhook UI |
| `GET` | `/discord-webhooks` | ✓ | Webhook list JSON |
| `POST` | `/discord-webhooks` | ✓ | Add webhook |
| `DELETE` | `/discord-webhooks/:id` | ✓ | Remove webhook |

## Database

SQLite at `./data/ebird-webhooks.db` (or `/app/data/` in Docker, persisted via volume mount).

Tables: `observations`, `discord_webhooks`.

## Troubleshooting

**No observations** — verify `EBIRD_API_KEY` is set. Trigger a manual fetch via `POST /scrape-now` and check logs: `docker logs ebird-rarities -f`

**Discord not firing** — confirm at least one webhook is registered in `/settings` and that the county name matches.

**DB lost on redeploy** — ensure the volume mount is in place (`-v ~/ebird-data:/app/data`). Copy a local DB to EC2 with `scp` if needed.
