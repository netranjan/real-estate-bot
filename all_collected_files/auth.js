// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const pool = require('../db/pool');

// ── Login page ──
router.get('/login', (req, res) => {
  // If already logged in, redirect to admin dashboard
  if (req.session && req.session.userId) return res.redirect('/admin');
  res.render('login', { title: 'Login', error: null, req });
});

// ── Handle login form ──
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { title: 'Login', error: 'Username and password are required.', req });
  }

  try {
    const result = await pool.query(
      'SELECT user_id, username, password_hash, role, display_name, client_id FROM users WHERE username = $1 AND active = TRUE',
      [username]
    );

    if (result.rows.length === 0) {
      return res.render('login', { title: 'Login', error: 'Invalid credentials.', req });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.render('login', { title: 'Login', error: 'Invalid credentials.', req });
    }

    // Set session
    req.session.userId = user.user_id;
    req.session.username = user.username;
    req.session.userRole = user.role;
    req.session.displayName = user.display_name;
    req.session.clientId = user.client_id; // null for super_admin

    // Redirect to original page or admin dashboard
    const returnTo = req.session.returnTo || '/admin';
    delete req.session.returnTo;
    return res.redirect(returnTo);

  } catch (err) {
    console.error('Login error:', err);
    return res.render('login', { title: 'Login', error: 'An error occurred. Please try again.', req });
  }
});

// ── Logout ──
router.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error('Logout error:', err);
    res.redirect('/auth/login');
  });
});

module.exports = router;