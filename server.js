const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { Pool } = require('pg');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

let tapCount = 0;
let lastTapTime = 0;

async function initializeDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
        plan VARCHAR(50),
        start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expiry_date TIMESTAMP NOT NULL,
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        amount DECIMAL(10, 2),
        currency VARCHAR(10),
        plan VARCHAR(50),
        status VARCHAR(50) DEFAULT 'pending',
        paystack_ref VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bot_instances (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        session_id VARCHAR(1000),
        bot_name VARCHAR(255),
        owner_number VARCHAR(20),
        is_active BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Database initialized');
  } catch (error) {
    console.error('❌ Database error:', error);
  }
}

app.post('/api/admin-tap', (req, res) => {
  const now = Date.now();
  if (now - lastTapTime > 5000) tapCount = 0;
  tapCount++;
  lastTapTime = now;

  if (tapCount >= 10) {
    tapCount = 0;
    return res.json({ success: true, showPasswordPrompt: true });
  }

  res.json({ success: true, showPasswordPrompt: false, tapsLeft: 10 - tapCount });
});

app.post('/api/admin-login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'JokerAdmin123';
  res.json({ success: password === adminPassword, message: password === adminPassword ? 'Admin access granted' : 'Invalid password' });
});

app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const usersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const activeResult = await pool.query("SELECT COUNT(*) as count FROM subscriptions WHERE status = 'active' AND expiry_date > NOW()");
    const paymentsResult = await pool.query('SELECT user_id, amount, plan, status, created_at FROM payments ORDER BY created_at DESC LIMIT 10');
    const userSubscriptions = await pool.query(`
      SELECT u.email, s.plan, s.expiry_date, s.status
      FROM users u
      JOIN subscriptions s ON u.id = s.user_id
      ORDER BY s.expiry_date ASC
    `);

    res.json({
      success: true,
      stats: {
        totalUsers: Number(usersResult.rows[0].count),
        activeUsers: Number(activeResult.rows[0].count),
        expiredCount: Number(usersResult.rows[0].count) - Number(activeResult.rows[0].count),
      },
      recentPayments: paymentsResult.rows,
      userSubscriptions: userSubscriptions.rows,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });

  try {
    const result = await pool.query(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email',
      [email, password]
    );

    const userId = result.rows[0].id;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + parseInt(process.env.TRIAL_DAYS || 1));

    await pool.query(
      'INSERT INTO subscriptions (user_id, plan, expiry_date, status) VALUES ($1, $2, $3, $4)',
      [userId, 'trial', expiryDate, 'active']
    );

    res.json({ success: true, message: 'User created with 1-day free trial', user: { id: userId, email: result.rows[0].email }, trialEnds: expiryDate });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/subscription/status', async (req, res) => {
  const { userId } = req.body;
  try {
    const result = await pool.query(
      `SELECT plan, expiry_date, status FROM subscriptions WHERE user_id = $1 ORDER BY expiry_date DESC LIMIT 1`,
      [userId]
    );

    if (!result.rows.length) {
      return res.json({ success: false, message: 'No active subscription' });
    }

    const sub = result.rows[0];
    const now = new Date();
    const isActive = new Date(sub.expiry_date) > now;

    res.json({
      success: true,
      plan: sub.plan,
      expiryDate: sub.expiry_date,
      isActive,
      daysLeft: Math.max(0, Math.ceil((new Date(sub.expiry_date) - now) / (1000 * 60 * 60 * 24))),
    });
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/payment/initialize', async (req, res) => {
  const { userId, email, plan } = req.body;
  const plans = {
    weekly: { amount: 500, priceInKobo: 50000 },
    monthly: { amount: 3000, priceInKobo: 300000 },
  };

  if (!plans[plan]) return res.status(400).json({ success: false, message: 'Invalid plan' });

  try {
    const reference = `joker-${userId}-${Date.now()}`;
    const paymentResult = await pool.query(
      'INSERT INTO payments (user_id, amount, currency, plan, status, paystack_ref) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [userId, plans[plan].amount, 'NGN', plan, 'pending', reference]
    );

    res.json({
      success: true,
      message: 'Payment initialized',
      reference,
      amount: plans[plan].priceInKobo,
      email,
      plan,
      paymentId: paymentResult.rows[0].id,
    });
  } catch (error) {
    console.error('Payment init error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/payment/verify', async (req, res) => {
  const { reference, userId, plan } = req.body;

  try {
    await pool.query('UPDATE payments SET status = $1 WHERE paystack_ref = $2', ['completed', reference]);

    const expiryDate = new Date();
    if (plan === 'weekly') expiryDate.setDate(expiryDate.getDate() + 7);
    else if (plan === 'monthly') expiryDate.setDate(expiryDate.getDate() + 30);

    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, expiry_date, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, expiry_date = EXCLUDED.expiry_date, status = EXCLUDED.status`,
      [userId, plan, expiryDate, 'active']
    );

    res.json({ success: true, message: 'Payment verified and subscription activated', expiryDate });
  } catch (error) {
    console.error('Payment verify error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/bot/save-session', async (req, res) => {
  const { userId, sessionId, botName, ownerNumber } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO bot_instances (user_id, session_id, bot_name, owner_number, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [userId, sessionId, botName || 'JOKER~👺', ownerNumber, true]
    );
    res.json({ success: true, message: 'Bot session saved', botId: result.rows[0].id });
  } catch (error) {
    console.error('Bot session error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/bot/instances/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      'SELECT id, bot_name, owner_number, is_active, created_at FROM bot_instances WHERE user_id = $1',
      [userId]
    );
    res.json({ success: true, bots: result.rows });
  } catch (error) {
    console.error('Bot instances error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'JOKER Bot SaaS Backend is running' });
});

const PORT = process.env.PORT || 3000;
initializeDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ JOKER Bot SaaS Backend running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
  });
});

module.exports = app;
