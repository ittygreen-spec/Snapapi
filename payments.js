// SnapAPI Payment System — Stripe Integration
// Set STRIPE_SECRET_KEY in environment to activate
// Get your keys at https://dashboard.stripe.com/apikeys

const express = require('express');
const router = express.Router();
const db = require('./db');
const { v4: uuidv4 } = require('uuid');

let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('💳 Stripe integration active');
  } else {
    console.log('💳 Stripe not configured — set STRIPE_SECRET_KEY env var');
  }
} catch(e) {
  console.log('💳 Stripe SDK not installed, using invoice mode');
}

const PLANS = {
  free: { name: 'Free', price: 0, credits: 100, stripe_price_id: null },
  pro: { name: 'Pro', price: 29, credits: 10000, stripe_price_id: process.env.STRIPE_PRO_PRICE_ID || null },
  pro_monthly: { name: 'Pro Monthly', price: 29, credits: 10000, stripe_price_id: process.env.STRIPE_PRO_PRICE_ID || null },
  credits_500: { name: '500 Bonus Credits', price: 5, credits: 500, stripe_price_id: null },
  credits_2000: { name: '2000 Bonus Credits', price: 15, credits: 2000, stripe_price_id: null },
};

// Ensure invoices table exists
db.exec(`CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  stripe_session_id TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

function auth(req, res, next) {
  const token = req.headers['x-api-key'] || req.query.key;
  if (!token) return res.status(401).json({ error: 'Missing API key.' });
  const row = db.prepare('SELECT * FROM tokens WHERE id = ?').get(token);
  if (!row) return res.status(401).json({ error: 'Invalid API key.' });
  req.token = row;
  next();
}

// ─── List plans ───
router.get('/plans', (req, res) => {
  res.json({
    plans: [
      { id: 'free', name: 'Free', price: 0, credits: 100, popular: false },
      { id: 'pro_monthly', name: 'Pro', price: 29, credits: 10000, popular: true },
      { id: 'credits_500', name: 'Bonus Pack (500 credits)', price: 5, credits: 500, popular: false },
      { id: 'credits_2000', name: 'Bonus Pack (2000 credits)', price: 15, credits: 2000, popular: false },
    ],
    stripe_active: !!stripe,
    currency: 'USD'
  });
});

// ─── Create checkout session ───
router.post('/checkout', auth, async (req, res) => {
  const { plan_id } = req.body;
  const plan = PLANS[plan_id];
  
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });
  if (plan.price === 0) {
    // Free plan — instant upgrade
    db.prepare('UPDATE tokens SET plan = ?, quota = ? WHERE id = ?').run('free', plan.credits, req.token.id);
    return res.json({ success: true, message: 'Free plan activated', plan: 'free' });
  }

  const invoiceId = uuidv4();

  if (stripe && plan.stripe_price_id) {
    // Stripe checkout
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
        client_reference_id: req.token.id,
        metadata: { invoice_id: invoiceId, plan: plan_id, token_id: req.token.id },
        success_url: `${req.headers.origin || 'https://snapapi-production-50a0.up.railway.app'}/admin.html?upgraded=true`,
        cancel_url: `${req.headers.origin || 'https://snapapi-production-50a0.up.railway.app'}/upgrade/?cancelled=true`,
      });
      db.prepare('INSERT INTO invoices (id, token_id, plan, amount, status, stripe_session_id) VALUES (?, ?, ?, ?, ?, ?)').run(invoiceId, req.token.id, plan_id, plan.price, 'pending', session.id);
      return res.json({ success: true, checkout_url: session.url, invoice_id: invoiceId });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    // Invoice mode (no Stripe keys)
    db.prepare('INSERT INTO invoices (id, token_id, plan, amount, status) VALUES (?, ?, ?, ?, ?)').run(invoiceId, req.token.id, plan_id, plan.price, 'pending');
    return res.json({
      success: true,
      invoice_id: invoiceId,
      checkout_url: null,
      message: `Invoice #${invoiceId.substring(0,8)} created. Email hello@snapapi.dev to complete payment.`
    });
  }
});

// ─── Stripe webhook (post-payment) ───
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(200).json({ received: true });
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const tokenId = session.metadata.token_id;
    const plan = session.metadata.plan;
    const invoiceId = session.metadata.invoice_id;
    const planConfig = PLANS[plan];
    if (planConfig && tokenId) {
      db.prepare('UPDATE invoices SET status = ?, paid_at = datetime(\'now\') WHERE id = ?').run('paid', invoiceId);
      db.prepare('UPDATE tokens SET plan = ?, quota = quota + ? WHERE id = ?').run(plan, planConfig.credits, tokenId);
      console.log(`💳 Payment completed: ${plan} for token ${tokenId}`);
    }
  }
  res.json({ received: true });
});

// ─── Verify payment manually ───
router.post('/verify', auth, (req, res) => {
  const { invoice_id } = req.body;
  if (!invoice_id) return res.status(400).json({ error: 'Missing invoice_id' });
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND token_id = ?').get(invoice_id, req.token.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  res.json({
    invoice_id: inv.id,
    plan: inv.plan,
    amount: inv.amount,
    status: inv.status,
    paid_at: inv.paid_at
  });
});

// ─── List invoices ───
router.get('/invoices', auth, (req, res) => {
  const invoices = db.prepare('SELECT id, plan, amount, status, paid_at, created_at FROM invoices WHERE token_id = ? ORDER BY created_at DESC').all(req.token.id);
  res.json(invoices);
});

// ─── Admin: Upgrade a key manually (for after payment received) ───
router.post('/admin/upgrade', auth, (req, res) => {
  const { target_key, plan } = req.body;
  if (!target_key || !plan) return res.status(400).json({ error: 'Missing target_key or plan' });
  const planConfig = PLANS[plan];
  if (!planConfig) return res.status(400).json({ error: 'Invalid plan' });
  
  const target = db.prepare('SELECT * FROM tokens WHERE id = ?').get(target_key);
  if (!target) return res.status(404).json({ error: 'Target key not found' });
  
  db.prepare('UPDATE tokens SET plan = ?, quota = quota + ? WHERE id = ?').run(plan, planConfig.credits, target_key);
  res.json({ success: true, message: `Upgraded to ${plan}`, credits_added: planConfig.credits });
});

module.exports = router;
module.exports.PLANS = PLANS;
module.exports.handleWebhook = handleWebhook;

// ─── Stripe webhook handler (exported for use in server.js before JSON middleware) ───
async function handleWebhook(req, res) {
  if (!stripe) return res.status(200).json({ received: true });
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const tokenId = session.metadata?.token_id;
    const plan = session.metadata?.plan;
    const invoiceId = session.metadata?.invoice_id;
    const planConfig = PLANS[plan];
    if (planConfig && tokenId) {
      db.prepare('UPDATE invoices SET status = ?, paid_at = datetime(\'now\') WHERE id = ?').run('paid', invoiceId);
      db.prepare('UPDATE tokens SET plan = ?, quota = quota + ? WHERE id = ?').run(plan, planConfig.credits, tokenId);
      console.log(`💳 Payment completed: ${plan} for token ${tokenId}`);
    }
  }
  res.json({ received: true });
}