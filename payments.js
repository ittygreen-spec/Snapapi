// Payment/plan management for SnapAPI
const express = require('express');
const router = express.Router();
const db = require('./db');
const { v4: uuidv4 } = require('uuid');

// Plans configuration
const PLANS = {
  free: { name: 'Free', price: 0, credits: 100 },
  pro: { name: 'Pro', price: 29, credits: 10000 },
  enterprise: { name: 'Enterprise', price: -1, credits: -1 },
};

// ─── Auth middleware ───
function auth(req, res, next) {
  const token = req.headers['x-api-key'] || req.query.key;
  if (!token) return res.status(401).json({ error: 'Missing API key.' });
  const row = db.prepare('SELECT * FROM tokens WHERE id = ?').get(token);
  if (!row) return res.status(401).json({ error: 'Invalid API key.' });
  req.token = row;
  next();
}

// ─── Get available plans ───
router.get('/plans', (req, res) => {
  res.json({ plans: Object.values(PLANS).map(p => ({
    name: p.name,
    price: p.price,
    credits: p.credits,
    popular: p.name === 'Pro'
  }))});
});

// ─── Create checkout session ───
router.post('/checkout', auth, (req, res) => {
  const { plan } = req.body;
  
  if (!plan || !PLANS[plan]) {
    return res.status(400).json({ error: 'Invalid plan. Choose: free, pro, enterprise' });
  }

  if (plan === 'free') {
    // Free plan: upgrade immediately
    db.prepare('UPDATE tokens SET plan = ?, quota = ? WHERE id = ?').run('free', 100, req.token.id);
    return res.json({ success: true, message: 'Upgraded to Free plan', plan: 'free', credits: 100 });
  }

  // For paid plans, generate an invoice
  const invoiceId = uuidv4();
  const planConfig = PLANS[plan];

  db.prepare(`CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    token_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();

  db.prepare('INSERT INTO invoices (id, token_id, plan, amount, status) VALUES (?, ?, ?, ?, ?)').run(
    invoiceId, req.token.id, plan, planConfig.price, 'pending'
  );

  res.json({
    success: true,
    invoice: {
      id: invoiceId,
      plan: planConfig.name,
      amount: planConfig.price,
      status: 'pending',
      // In production, this would be a Stripe/加密货币 checkout URL
      payment_url: null,
      instructions: 'Email hello@snapapi.dev with invoice ID to complete payment, or set STRIPE_SECRET_KEY env var for automated payments.'
    }
  });
});

// ─── Manual payment confirmation (for demo) ───
router.post('/confirm-payment', auth, (req, res) => {
  const { invoice_id } = req.body;
  if (!invoice_id) return res.status(400).json({ error: 'Missing invoice_id' });

  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND token_id = ?').get(invoice_id, req.token.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status !== 'pending') return res.status(400).json({ error: 'Invoice already processed' });

  // Mark paid and upgrade
  db.prepare('UPDATE invoices SET status = ?, paid_at = datetime(\'now\') WHERE id = ?').run('paid', invoice_id);
  
  const planConfig = PLANS[invoice.plan];
  db.prepare('UPDATE tokens SET plan = ?, quota = ? WHERE id = ?').run(invoice.plan, planConfig.credits, req.token.id);

  res.json({ success: true, message: `Upgraded to ${planConfig.name}`, plan: invoice.plan });
});

// ─── Add credits (top-up) ───
router.post('/add-credits', auth, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 1) return res.status(400).json({ error: 'Invalid amount' });

  const cost = Math.ceil(amount / 100) * 5; // $5 per 100 credits
  db.prepare('UPDATE tokens SET quota = quota + ? WHERE id = ?').run(amount, req.token.id);

  res.json({
    success: true,
    credits_added: amount,
    cost: cost,
    message: `${amount} credits added. Thank you! In production, charge $${cost} via Stripe.`
  });
});

// ─── Invoices list ───
router.get('/invoices', auth, (req, res) => {
  const invoices = db.prepare('SELECT * FROM invoices WHERE token_id = ? ORDER BY created_at DESC').all(req.token.id);
  res.json(invoices);
});

module.exports = router;
module.exports.PLANS = PLANS;