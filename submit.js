// Automated API directory submission script
// Run: node submit.js

const https = require('https');
const http = require('http');

const API_URL = 'https://snapapi-production-50a0.up.railway.app';
const DOMAIN = 'getsnapapi.org';

const submissions = [
  {
    name: 'RapidAPI',
    url: 'https://api.rapidapi.com/v1/providers',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      name: 'SnapAPI',
      description: 'Website Intelligence API — screenshots, metadata extraction, and social previews for any URL. One API call.',
      website: DOMAIN,
      docs_url: `${API_URL}`,
      pricing_url: `${API_URL}/upgrade`,
      tags: ['screenshot', 'website', 'metadata', 'og-image', 'browser-automation', 'preview'],
      category: 'Tools',
      plans: [
        { name: 'Free', price: 0, requests: 100, period: 'month' },
        { name: 'Pro', price: 29, requests: 10000, period: 'month' }
      ]
    }
  },
  {
    name: 'APIs.guru',
    url: 'https://api.apis.guru/v2/providers',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      name: 'SnapAPI',
      description: 'Website Intelligence API — screenshots and metadata',
      url: API_URL,
      logo: `${API_URL}/favicon.ico`
    }
  }
];

async function submit(entry) {
  return new Promise((resolve) => {
    try {
      const u = new URL(entry.url);
      const client = u.protocol === 'https:' ? https : http;
      const data = JSON.stringify(entry.body);
      
      const req = client.request(entry.url, {
        method: entry.method || 'POST',
        headers: {
          ...entry.headers,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          console.log(`✅ ${entry.name}: HTTP ${res.statusCode}`);
          if (body) console.log(`   Response: ${body.substring(0, 200)}`);
          resolve({ name: entry.name, status: res.statusCode });
        });
      });
      req.on('error', (e) => {
        console.log(`❌ ${entry.name}: ${e.message}`);
        resolve({ name: entry.name, error: e.message });
      });
      req.write(data);
      req.end();
    } catch (e) {
      console.log(`❌ ${entry.name}: ${e.message}`);
      resolve({ name: entry.name, error: e.message });
    }
  });
}

async function main() {
  console.log('=== Submitting SnapAPI to API Directories ===\n');
  console.log(`URL: ${API_URL}\n`);
  
  for (const entry of submissions) {
    await submit(entry);
  }
  
  console.log('\n=== Done ===');
  console.log('\nManual submissions needed (create accounts):');
  console.log('1. Product Hunt: https://producthunt.com/posts/create');
  console.log('2. Hacker News: https://news.ycombinator.com/submit');
  console.log('3. ProgrammableWeb: https://programmableweb.com/user/register');
  console.log('4. RapidAPI: https://rapidapi.com/developer (create provider account)');
}

main();