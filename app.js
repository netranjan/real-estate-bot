require('dotenv').config();
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const fs = require('fs');
const path = require('path');
const pool = require('./db/pool');
const { handleIncomingMessage } = require('./core/engine');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ... after const app = express();

// ✅ Add session middleware BEFORE routes
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'session'   // will auto-create a sessions table
  }),
  secret: process.env.SESSION_SECRET || 'your-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

// ── EJS View Engine ──
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// ── Serve static files (CSS, JS, images) ──
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware (set currentUser for all views) ──
const { setLocals } = require('./middleware/auth');
app.use(setLocals);

// ── Auth routes (login/logout) ──
const authRoutes = require('./routes/auth');
app.use('/auth', authRoutes);

// ── Validate critical env vars ──
function validateEnv() {
  const required = ['DATABASE_URL', 'VERIFY_TOKEN'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error('❌ Missing env vars:', missing.join(', '));
    process.exit(1);
  }
}

// ── Check database connection ──
async function checkDb() {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected');
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    process.exit(1);
  }
}

// ── Auto-initialize schema + views + seeds on startup ──
async function initSchema() {
  const setupFile = path.join(__dirname, 'db', 'setup.sql');

  if (!fs.existsSync(setupFile)) {
    console.warn(`⚠️  ${setupFile} not found, skipping auto-setup`);
    return;
  }

  try {
    const sql = fs.readFileSync(setupFile, 'utf8');
    await pool.query(sql);
    console.log('✅ Database setup complete (tables, views, indexes, seeds)');
  } catch (err) {
    console.error('❌ Database setup failed:', err.message);
  }
}

// ── Admin Panel Routes ──
const adminRoutes = require('./admin/routes');
app.use('/admin', adminRoutes);

// ── Webhook verification (Meta) ──
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── Incoming WhatsApp messages ──
app.post('/webhook', async (req, res) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('📩 Webhook:', JSON.stringify(req.body, null, 2));
  }

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  if (!value?.messages) {
    return res.sendStatus(200);
  }

  try {
    await handleIncomingMessage(req.body);
  } catch (error) {
    console.error('❌ Webhook handler error:', error.message);
  }

  res.sendStatus(200);
});

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'WhatsApp Flow Engine', timestamp: new Date().toISOString() });
});

// ── Manual message sender (admin / testing) ──
app.post('/send-message', async (req, res) => {
  const { phoneNumber, message, clientId } = req.body;

  if (!phoneNumber || !message) {
    return res.status(400).json({ error: 'Missing phoneNumber or message' });
  }

  try {
    const send = require('./whatsapp/send');
    const { textMessage } = require('./whatsapp/payloads');
    const db = require('./db/queries');

    const targetClientId = clientId || parseInt(process.env.DEFAULT_CLIENT_ID, 10) || 1;
    const client = await db.getClientById(targetClientId);

    if (!client?.meta_phone_number_id || !client?.meta_access_token) {
      return res.status(400).json({ error: 'Client WhatsApp credentials not configured' });
    }

    await send({
      phoneNumberId: client.meta_phone_number_id,
      accessToken: client.meta_access_token,
      payload: textMessage(phoneNumber, message),
    });

    res.json({ success: true, message: 'Message sent' });
  } catch (error) {
    console.error('❌ Send message error:', error.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── Graceful shutdown ──
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, closing pool...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received, closing pool...');
  await pool.end();
  process.exit(0);
});

// ── Start server ──
(async () => {
  validateEnv();
  await checkDb();
  await initSchema();

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Webhook URL: http://localhost:${PORT}/webhook`);
    console.log(`🎛️  Admin Panel: http://localhost:${PORT}/admin`);
  });
})();