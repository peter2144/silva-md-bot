const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { Pool } = require('pg');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Admin tap counter
let tapCount = 0;
let lastTapTime = 0;

// Database initialization
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
        user_id INTEGER NOT NULL REFERENCES users(id),
        plan VARCHAR(50), -- 'trial', 'weekly', 'monthly'
        start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expiry_date TIMESTAMP NOT NULL,
        status VARCHAR(50) DEFAULT 'active', -- 'active', 'expired', 'cancelled'
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        amount DECIMAL(10, 2),
        currency VARCHAR(10),
        plan VARCHAR(50),
        status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'completed', 'failed'
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

// Routes

// Admin tap counter (10 taps = show password prompt)
app.post('/api/admin-tap', (req, res) => {
  const now = Date.now();
  
  // Reset counter if more than 5 seconds have passed
  if (now - lastTapTime > 5000) {
    tapCount = 0;
  }
  
  tapCount++;
  lastTapTime = now;

  if (tapCount >= 10) {
    tapCount = 0;
    res.json({ success: true, showPasswordPrompt: true });
  } else {
    res.json({ success: true, showPasswordPrompt: false, tapsLeft: 10 - tapCount });
  }
});

// Verify admin password
app.post('/api/admin-login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'JokerAdmin123';

  if (password === adminPassword) {
    res.json({ success: true, message: 'Admin access granted' });
  } else {
    res.json({ success: false, message: 'Invalid password' });
  }
});

// Get dashboard data (admin only)
app.get('/api/admin/dashboard', async (req, res) => {
  try {
    // Get total users
    const usersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalUsers = usersResult.rows[0].count;

    // Get active subscriptions
    const activeResult = await pool.query(
      "SELECT COUNT(*) as count FROM subscriptions WHERE status = 'active' AND expiry_date > NOW()"
    );
    const activeUsers = activeResult.rows[0].count;

    // Get recent payments
    const paymentsResult = await pool.query(
      "SELECT user_id, amount, plan, status, created_at FROM payments ORDER BY created_at DESC LIMIT 10"
    );

    // Get users with expiry dates
    const usersWithExpiry = await pool.query(`
      SELECT u.email, s.plan, s.expiry_date, s.status 
      FROM users u 
      JOIN subscriptions s ON u.id = s.user_id 
      ORDER BY s.expiry_date ASC
    `);

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        expiredCount: totalUsers - activeUsers
      },
      recentPayments: paymentsResult.rows,
      userSubscriptions: usersWithExpiry.rows
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// User signup
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required' });
  }

  try {
    // Create user
    const result = await pool.query(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email',
      [email, password] // In production, hash the password!
    );

    const userId = result.rows[0].id;

    // Create free trial subscription (1 day)
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + parseInt(process.env.TRIAL_DAYS || 1));

    await pool.query(
      'INSERT INTO subscriptions (user_id, plan, expiry_date) VALUES ($1, $2, $3)',
      [userId, 'trial', expiryDate]
    );

    res.json({
      success: true,
      message: 'User created with 1-day free trial',
      user: { id: userId, email: result.rows[0].email },
      trialEnds: expiryDate
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Check subscription status
app.post('/api/subscription/status', async (req, res) => {
  const { userId } = req.body;

  try {
    const result = await pool.query(
      `SELECT plan, expiry_date, status FROM subscriptions 
       WHERE user_id = $1 AND status = 'active' 
       ORDER BY expiry_date DESC LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
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
      daysLeft: Math.ceil((new Date(sub.expiry_date) - now) / (1000 * 60 * 60 * 24))
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Initialize Paystack payment
app.post('/api/payment/initialize', async (req, res) => {
  const { userId, email, plan } = req.body;

  const plans = {
    weekly: { amount: 50000, price: 500 }, // 500 NGN in kobo
    monthly: { amount: 300000, price: 3000 } // 3000 NGN in kobo
  };

  if (!plans[plan]) {
    return res.status(400).json({ success: false, message: 'Invalid plan' });
  }

  const planData = plans[plan];

  try {
    // Create payment record
    const paymentResult = await pool.query(
      'INSERT INTO payments (user_id, amount, currency, plan, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [userId, planData.price, 'NGN', plan, 'pending']
    );

    const paymentId = paymentResult.rows[0].id;

    // In production, call Paystack API here
    // For now, return a reference
    const reference = `joker-${userId}-${paymentId}-${Date.now()}`;

    res.json({
      success: true,
      message: 'Payment initialized',
      reference,
      amount: planData.amount,
      email,
      plan,
      paymentId
    });
  } catch (error) {
    console.error('Payment init error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Verify Paystack payment
app.post('/api/payment/verify', async (req, res) => {
  const { reference, userId, plan } = req.body;

  try {
    // In production, verify with Paystack API
    // For demo, we'll mark as completed

    // Update payment status
    await pool.query(
      'UPDATE payments SET status = $1 WHERE paystack_ref = $2',
      ['completed', reference]
    );

    // Calculate expiry based on plan
    const expiryDate = new Date();
    if (plan === 'weekly') {
      expiryDate.setDate(expiryDate.getDate() + 7);
    } else if (plan === 'monthly') {
      expiryDate.setDate(expiryDate.getDate() + 30);
    }

    // Create/update subscription
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, expiry_date, status) 
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET 
       plan = $2, expiry_date = $3, status = $4`,
      [userId, plan, expiryDate, 'active']
    );

    res.json({
      success: true,
      message: 'Payment verified and subscription activated',
      expiryDate
    });
  } catch (error) {
    console.error('Payment verify error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Save bot session
app.post('/api/bot/save-session', async (req, res) => {
  const { userId, sessionId, botName, ownerNumber } = req.body;

  try {
    const result = await pool.query(
      'INSERT INTO bot_instances (user_id, session_id, bot_name, owner_number, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [userId, sessionId, botName || 'JOKER~👺', ownerNumber, true]
    );

    res.json({
      success: true,
      message: 'Bot session saved',
      botId: result.rows[0].id
    });
  } catch (error) {
    console.error('Bot session error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get bot instances for user
app.get('/api/bot/instances/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      'SELECT id, bot_name, owner_number, is_active, created_at FROM bot_instances WHERE user_id = $1',
      [userId]
    );

    res.json({
      success: true,
      bots: result.rows
    });
  } catch (error) {
    console.error('Bot instances error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'JOKER Bot SaaS Backend is running' });
});

// Start server
const PORT = process.env.PORT || 3000;

initializeDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ JOKER Bot SaaS Backend running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📍 Admin dashboard: POST http://localhost:${PORT}/api/admin-tap (10 taps)\n`);
  });
});

module.exports = app;
