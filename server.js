const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const paymentsRouter = require('./payments');

const app = express();
const PORT = process.env.PORT || 3099;

app.use(cors());

// Stripe webhook route — MUST be before express.json() (needs raw body)
const webhookRouter = express.Router();
webhookRouter.post('/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const payments = require('./payments');
  payments.handleWebhook(req, res);
});
app.use('/api', webhookRouter);

app.use(express.json());

// Payment routes (non-webhook)
app.use('/api/payments', paymentsRouter);

// Static landing page
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth middleware ───
function auth(req, res, next) {
  const token = req.headers['x-api-key'] || req.query.key;
  if (!token) {
    return res.status(401).json({ error: 'Missing API key. Use X-Api-Key header or ?key= parameter.' });
  }
  const row = db.prepare('SELECT * FROM tokens WHERE id = ?').get(token);
  if (!row) {
    return res.status(401).json({ error: 'Invalid API key.' });
  }
  if (row.quota !== -1 && row.used >= row.quota) {
    return res.status(429).json({ error: 'Quota exceeded.' });
  }
  req.token = row;
  next();
}

// ─── Rate limit ───
function consumeQuota(req, res, next) {
  db.prepare('UPDATE tokens SET used = used + 1 WHERE id = ?').run(req.token.id);
  next();
}

// ─── ScreenshotOne API helper ───
const SCREENSHOTONE_KEY = process.env.SCREENSHOTONE_KEY || 'c9f505548f6171340eff';

function takeScreenshot(url, options = {}) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      access_key: SCREENSHOTONE_KEY,
      url: url,
      format: options.format || 'png',
      viewport_width: String(options.width || 1280),
      viewport_height: String(options.height || 720),
      full_page: options.fullPage ? 'true' : 'false',
      delay: String(options.delay || 0),
      device_scale_factor: '1',
      block_ads: 'true',
      block_trackers: 'true',
    });
    
    const apiUrl = `https://api.screenshotone.com/take?${params.toString()}`;
    
    https.get(apiUrl, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => reject(new Error(`ScreenshotOne API error ${res.statusCode}: ${body.substring(0, 200)}`)));
        return;
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// ─── Helper: fetch HTML and extract metadata ───
function fetchMetadata(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 15000 }, (res) => {
      let html = '';
      res.on('data', d => html += d.toString());
      res.on('end', () => {
        const getMeta = (name) => {
          const patterns = [
            new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([^"']*)["']`, 'i'),
            new RegExp(`<meta\\s+property=["']og:${name}["']\\s+content=["']([^"']*)["']`, 'i'),
            new RegExp(`<meta\\s+name=["']twitter:${name}["']\\s+content=["']([^"']*)["']`, 'i'),
            new RegExp(`<meta\\s+content=["']([^"']*)["']\\s+name=["']${name}["']`, 'i'),
            new RegExp(`<meta\\s+content=["']([^"']*)["']\\s+property=["']og:${name}["']`, 'i'),
          ];
          for (const p of patterns) {
            const match = html.match(p);
            if (match) return match[1];
          }
          return null;
        };
        const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
        const faviconMatch = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']*)["']/i);
        const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i);
        
        resolve({
          title: titleMatch ? titleMatch[1] : null,
          description: getMeta('description'),
          ogImage: getMeta('image'),
          ogTitle: getMeta('title'),
          ogDescription: getMeta('description'),
          favicon: faviconMatch ? faviconMatch[1] : null,
          url: url,
          canonical: canonicalMatch ? canonicalMatch[1] : null,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── API: Take screenshot ───
app.get('/api/screenshot', auth, consumeQuota, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const width = parseInt(req.query.width) || 1280;
  const height = parseInt(req.query.height) || 720;
  const format = req.query.format === 'jpeg' ? 'jpeg' : 'png';
  const fullPage = req.query.full === 'true';
  const delay = parseInt(req.query.delay) || 0;

  try {
    const imageBuffer = await takeScreenshot(url, { width, height, format, fullPage, delay });
    db.prepare('INSERT INTO usage_log (api_key_id, endpoint, target_url, status) VALUES (?, ?, ?, ?)').run(req.token.id, '/api/screenshot', url, 200);
    res.set('Content-Type', format === 'jpeg' ? 'image/jpeg' : 'image/png');
    res.set('X-Credits-Remaining', String(req.token.quota - req.token.used - 1));
    res.send(imageBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Extract page metadata ───
app.get('/api/metadata', auth, consumeQuota, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });

  try {
    const metadata = await fetchMetadata(url);
    db.prepare('INSERT INTO usage_log (api_key_id, endpoint, target_url, status) VALUES (?, ?, ?, ?)').run(req.token.id, '/api/metadata', url, 200);
    res.json({ success: true, data: metadata, credits_remaining: req.token.quota - req.token.used - 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Check usage ───
app.get('/api/usage', auth, (req, res) => {
  const logs = db.prepare('SELECT endpoint, target_url, status, created_at FROM usage_log WHERE api_key_id = ? ORDER BY created_at DESC LIMIT 50').all(req.token.id);
  res.json({
    plan: req.token.plan,
    quota: req.token.quota,
    used: req.token.used,
    remaining: req.token.quota - req.token.used,
    recent: logs
  });
});

// ─── Create API key ───
app.post('/api/keys', auth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  
  const id = uuidv4();
  const key = 'snap_' + crypto.randomBytes(16).toString('hex');
  
  db.prepare('INSERT INTO api_keys (id, name, key, quota, used) VALUES (?, ?, ?, ?, 0)').run(id, name, key, 1000);
  
  res.json({ id, name, key });
});

// ─── List API keys ───
app.get('/api/keys', auth, (req, res) => {
  const keys = db.prepare('SELECT id, name, quota, used, created_at FROM api_keys ORDER BY created_at DESC').all();
  res.json(keys);
});

// ─── Demo endpoint (no auth) ───
app.get('/api/demo-screenshot', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const demoToken = db.prepare('SELECT * FROM tokens ORDER BY created_at ASC LIMIT 1').get();
  if (demoToken) {
    db.prepare('UPDATE tokens SET used = used + 1 WHERE id = ?').run(demoToken.id);
  }

  try {
    const imageBuffer = await takeScreenshot(url, { width: 800, height: 450, format: 'png' });
    res.set('Content-Type', 'image/png');
    res.send(imageBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Demo metadata (no auth for preview tool) ───
app.get('/api/demo-metadata', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });
  try {
    const metadata = await fetchMetadata(url);
    res.json({ success: true, data: metadata });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Status badge ───
app.get('/status/badge', (req, res) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const label = `uptime ${hours}h`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="130" height="20">
    <linearGradient id="b" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
    <rect rx="3" width="130" height="20" fill="#555"/>
    <rect rx="3" x="78" width="52" height="20" fill="#6c5ce7"/>
    <g fill="#fff" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
      <text x="5" y="14">snapapi</text>
      <text x="83" y="14">${label}</text>
    </g>
  </svg>`;
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'no-cache');
  res.send(svg);
});

// ─── Status page ───
app.get('/status', (req, res) => {
  const uptime = process.uptime();
  const totalCalls = db.prepare('SELECT COUNT(*) as c FROM usage_log').get().c;
  const recentErrors = db.prepare("SELECT COUNT(*) as c FROM usage_log WHERE status >= 400 AND created_at > datetime('now', '-1 hour')").get().c;
  res.json({
    status: 'operational',
    uptime_seconds: uptime,
    uptime_display: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    total_api_calls: totalCalls,
    errors_last_hour: recentErrors,
    service: 'SnapAPI'
  });
});

// ─── Referral: register ───
app.post('/api/referral', (req, res) => {
  const { key, ref } = req.body;
  if (!key || !ref) return res.status(400).json({ error: 'Missing key or ref' });
  // Check if key exists
  const row = db.prepare('SELECT * FROM tokens WHERE id = ?').get(key);
  if (!row) return res.status(400).json({ error: 'Invalid key' });
  // Only count each referral once
  const existing = db.prepare('SELECT * FROM referrals WHERE referred_key = ?').get(key);
  if (existing) return res.json({ bonus: 0, message: 'Already referred' });
  // Bonus credits
  db.prepare(`CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_key TEXT NOT NULL,
    referred_key TEXT NOT NULL UNIQUE,
    bonus_given INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  db.prepare('INSERT OR IGNORE INTO referrals (referrer_key, referred_key, bonus_given) VALUES (?, ?, ?)').run(ref, key, 50);
  db.prepare('UPDATE tokens SET quota = quota + 50 WHERE id = ?').run(key);
  db.prepare('UPDATE tokens SET quota = quota + 50 WHERE id = ?').run(ref);
  res.json({ bonus: 50, message: '50 bonus credits added!' });
});

// ─── Health ───
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    screenshot_api: 'screenshotone'
  });
});

// ─── Start ───
app.use('/api/payments', paymentsRouter);
async function start() {
  console.log('🚀 SnapAPI server starting (ScreenshotOne API)');
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`📸 SnapAPI running on http://0.0.0.0:${PORT}`);
    console.log(`📋 Health: http://localhost:${PORT}/health`);
  });
}

// Only start the server when not on Vercel
if (!process.env.VERCEL) {
  start().catch(console.error);
}

// Vercel serverless export
module.exports = app;
