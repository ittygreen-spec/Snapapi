# SnapAPI — Website Intelligence API

Screenshots, metadata extraction, and social previews for any URL. One API call.

## Quick Start

```bash
npm install
npx playwright install chromium
npm start
```

Server runs on `http://localhost:3099`.

## Deploy to Railway

1. Push this repo to GitHub
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Railway auto-detects Node.js — no config needed
4. Set `PORT` environment variable if needed (default: 3099)
5. Add custom domain in Railway dashboard → Settings

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/screenshot?url=&width=&height=` | API key | Returns PNG/JPEG |
| GET | `/api/metadata?url=` | API key | Returns JSON |
| GET | `/api/usage` | API key | Credit usage |
| GET | `/api/demo-screenshot?url=` | No | Free demo |
| GET | `/api/demo-metadata?url=` | No | Free demo |
| POST | `/api/keys` | API key | Create sub-keys |
| POST | `/api/referral` | API key | Referral credits |
| GET | `/api/payments/plans` | API key | Plan listing |
| GET | `/health` | No | Health check |
| GET | `/status` | No | Status page |
| GET | `/status/badge` | No | SVG badge |

## Default Credentials

- Demo key: `demo` (500 free credits)
- Admin key: printed on first startup

## DNS for Custom Domain

Add at your DNS provider:

```
snapapi.dev  CNAME  your-railway-app.up.railway.app
www.snapapi.dev  CNAME  snapapi.dev
```

Then set SSL to Full in Cloudflare.