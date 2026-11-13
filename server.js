const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  delay
} = require('@whiskeysockets/baileys');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'wadojo-super-secret-key-2026';
const SESSION_DIR = 'sessions/main_sender';

const USERS = [
  {
    id: 1,
    username: 'admin',
    passwordHash: bcrypt.hashSync('admin123', 10),
    role: 'superadmin',
    quota: 999999,
    blastCount: 0
  },
  {
    id: 2,
    username: 'member_budi',
    passwordHash: bcrypt.hashSync('member123', 10),
    role: 'member',
    quota: 50,
    blastCount: 0
  },
  {
    id: 3,
    username: 'vvip_sultan',
    passwordHash: bcrypt.hashSync('vvip123', 10),
    role: 'vvip',
    quota: Infinity,
    blastCount: 0
  }
];

let sock = null;
let currentQr = null;
let connectionStatus = 'disconnected';
let isConnecting = false;
let reconnectAttempts = 0;
let restriction = null; // { type, until, reason }

// Antrean blast di backend
const queue = {
  items: [],
  running: false,
  stopped: false,
  current: null,
  delaySeconds: 90,
  summary: { total: 0, success: 0, pending: 0, failed: 0, skipped: 0 }
};

function isRestricted() {
  if (!restriction) return false;
  if (restriction.until && Date.now() > restriction.until) {
    restriction = null;
    return false;
  }
  return true;
}

function setRestriction(type, untilMs, reason) {
  restriction = { type, until: untilMs || null, reason: reason || type };
  console.warn(`[Restriction] ${type} — blast dihentikan. ${reason || ''}`);
  queue.stopped = true;
}

function normalizePhone(phone) {
  let clean = String(phone).replace(/[^0-9]/g, '');
  if (clean.startsWith('0')) clean = '62' + clean.slice(1);
  return clean;
}

async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[Baileys] WA Web v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      // Fingerprint konsisten dengan WA Web asli
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 2000,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, reachoutTimeLock } = update;

      if (reachoutTimeLock?.isActive) {
        setRestriction(
          'REACHOUT_TIMELOCK',
          reachoutTimeLock.timeEnforcementEnds ? new Date(reachoutTimeLock.timeEnforcementEnds).getTime() : null,
          `Timelock aktif (${reachoutTimeLock.enforcementType || 'DEFAULT'})`
        );
      }

      if (qr) {
        currentQr = await qrcode.toDataURL(qr);
        connectionStatus = 'connecting';
        console.log('[Baileys] QR code baru di-generate.');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        connectionStatus = 'disconnected';
        currentQr = null;
        isConnecting = false;

        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log(`[Baileys] Sesi terputus (code: ${statusCode}).`);

        if (loggedOut) {
          reconnectAttempts = 0;
          console.log('[Baileys] Logged out — perlu scan QR ulang.');
        } else {
          // Backoff eksponensial: 5s, 15s, 60s, 300s (maks)
          const backoff = [5000, 15000, 60000, 300000][Math.min(reconnectAttempts, 3)];
          reconnectAttempts++;
          console.log(`[Baileys] Reconnect dalam ${backoff / 1000}s (percobaan ${reconnectAttempts}).`);
          setTimeout(() => connectToWhatsApp(), backoff);
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        currentQr = null;
        isConnecting = false;
        reconnectAttempts = 0;
        console.log('[Baileys] WhatsApp terhubung aktif.');
      }
    });

    // Deteksi message capping (peringatan sebelum dibatasi)
    sock.ev.on('message-capping.update', (payload) => {
      const status = payload?.status || payload?.capping_status;
      if (status === 'CAPPED' || status === 'SECOND_WARNING') {
        setRestriction('MESSAGE_CAPPING', null, `Status: ${status}`);
      } else {
        console.warn(`[Capping] ${status}`);
      }
    });

    // Deteksi error 463/479 pada pesan
    sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        const code = u.update?.messageStubParameters?.[0];
        if (code === '463') {
          setRestriction('ACCOUNT_RESTRICTED', null, 'Error 463: akun dibatasi, tidak bisa chat baru');
        } else if (code === '479') {
          console.warn('[Baileys] Error 479: stanza ditolak (sesi device usang).');
        }
      }
    });
  } catch (err) {
    console.error('[Baileys Init Error]:', err);
    isConnecting = false;
    const backoff = [5000, 15000, 60000, 300000][Math.min(reconnectAttempts, 3)];
    reconnectAttempts++;
    setTimeout(() => connectToWhatsApp(), backoff);
  }
}

connectToWhatsApp();

// Endpoint Autentikasi Pengguna
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS.find((u) => u.username === username);

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ success: false, message: 'Username atau password salah' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  return res.json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      quota: user.quota,
      blastCount: user.blastCount
    }
  });
});

// Endpoint Ambil QR & Status Koneksi
app.get('/api/qr', (req, res) => {
  res.json({
    status: connectionStatus,
    qr: currentQr,
    restriction
  });
});

// Endpoint Kirim Pesan Tunggal
app.post('/api/send', async (req, res) => {
  const { phone, message, imageBase64, buttons } = req.body;

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({
      success: false,
      message: 'WhatsApp belum terhubung. Harap scan QR code terlebih dahulu.'
    });
  }

  if (isRestricted()) {
    return res.status(429).json({
      success: false,
      message: `Akun sedang dibatasi (${restriction.type}). Blast dihentikan sementara.`
    });
  }

  if (!phone) {
    return res.status(400).json({ success: false, message: 'Nomor tujuan wajib diisi.' });
  }

  try {
    const result = await sendOne(phone, message, imageBase64, buttons);
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (error) {
    console.error('[Send Message Error]:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Helper: kirim satu pesan
async function sendOne(phone, message, imageBase64, buttons) {
  const cleanPhone = normalizePhone(phone);
  if (cleanPhone.length < 8) {
    return { success: false, message: 'Nomor tidak valid' };
  }
  const jid = `${cleanPhone}@s.whatsapp.net`;

  // Validasi nomor terdaftar di WhatsApp
  const [check] = await sock.onWhatsApp(jid);
  if (!check?.exists) {
    return { success: false, message: 'Nomor tidak terdaftar di WhatsApp', skipped: true };
  }

  let finalMessage = message || '';
  if (buttons && Array.isArray(buttons) && buttons.length > 0) {
    const buttonLinks = buttons
      .filter((b) => b.text && b.url)
      .map((b) => `👉 ${b.text}: ${b.url}`)
      .join('\n');
    if (buttonLinks) finalMessage += `\n\n${buttonLinks}`;
  }

  // Jeda natural singkat (bukan presence simulation)
  await delay(1000 + Math.floor(Math.random() * 2000));

  if (imageBase64) {
    const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    await sock.sendMessage(jid, { image: buffer, caption: finalMessage });
  } else {
    await sock.sendMessage(jid, { text: finalMessage });
  }

  return { success: true, message: 'Pesan berhasil terkirim' };
}

// Endpoint Mulai Blast (antrean di backend)
app.post('/api/blast/start', (req, res) => {
  const { phones, message, imageBase64, buttons, delaySeconds } = req.body;

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ success: false, message: 'WhatsApp belum terhubung.' });
  }

  if (queue.running) {
    return res.status(409).json({ success: false, message: 'Blast sedang berjalan.' });
  }

  const list = (Array.isArray(phones) ? phones : String(phones || '').split('\n'))
    .map((p) => String(p).trim())
    .filter(Boolean);

  if (list.length === 0) {
    return res.status(400).json({ success: false, message: 'Daftar nomor kosong.' });
  }
  if (!message && !imageBase64) {
    return res.status(400).json({ success: false, message: 'Pesan atau gambar wajib diisi.' });
  }

  queue.items = list.map((phone, idx) => ({
    id: idx + 1,
    phone,
    status: 'pending',
    time: '-',
    note: ''
  }));
  queue.delaySeconds = Math.max(30, Number(delaySeconds) || 90);
  queue.running = true;
  queue.stopped = false;
  queue.current = null;
  queue.summary = { total: list.length, success: 0, pending: list.length, failed: 0, skipped: 0 };

  runQueue(message, imageBase64, buttons).catch((err) => {
    console.error('[Queue Error]:', err);
    queue.running = false;
  });

  return res.json({ success: true, total: list.length });
});

// Endpoint Status Blast
app.get('/api/blast/status', (req, res) => {
  res.json({
    running: queue.running,
    stopped: queue.stopped,
    current: queue.current,
    items: queue.items,
    summary: queue.summary,
    restriction,
    connectionStatus
  });
});

// Endpoint Hentikan Blast
app.post('/api/blast/stop', (req, res) => {
  queue.stopped = true;
  res.json({ success: true });
});

// Worker antrean
async function runQueue(message, imageBase64, buttons) {
  for (const item of queue.items) {
    if (queue.stopped) break;
    if (item.status !== 'pending') continue;

    if (connectionStatus !== 'connected' || !sock) {
      item.status = 'failed';
      item.note = 'Koneksi terputus';
      item.time = new Date().toLocaleTimeString('id-ID');
      queue.summary.failed++;
      queue.summary.pending--;
      continue;
    }

    if (isRestricted()) {
      queue.stopped = true;
      break;
    }

    queue.current = item.phone;

    try {
      const result = await sendOne(item.phone, message, imageBase64, buttons);
      item.time = new Date().toLocaleTimeString('id-ID');
      if (result.success) {
        item.status = 'success';
        queue.summary.success++;
      } else if (result.skipped) {
        item.status = 'skipped';
        item.note = result.message || 'Nomor tidak terdaftar';
        queue.summary.skipped++;
      } else {
        item.status = 'failed';
        item.note = result.message || '';
        queue.summary.failed++;
      }
      queue.summary.pending--;
    } catch (err) {
      item.status = 'failed';
      item.note = err.message;
      item.time = new Date().toLocaleTimeString('id-ID');
      queue.summary.failed++;
      queue.summary.pending--;
    }

    // Jeda acak antar nomor
    if (queue.items.indexOf(item) < queue.items.length - 1 && !queue.stopped) {
      const base = queue.delaySeconds;
      const jitter = Math.floor(base * 0.5);
      const waitMs = (base + Math.floor(Math.random() * jitter)) * 1000;
      const endAt = Date.now() + waitMs;
      while (Date.now() < endAt && !queue.stopped) {
        await delay(1000);
      }
    }
  }

  queue.running = false;
  queue.current = null;
  console.log('[Queue] Blast selesai.');
}

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Server WA Blast Backend aktif di http://localhost:${PORT}`);
});
