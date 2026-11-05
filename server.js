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
  Browsers
} = require('@whiskeysockets/baileys');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const JWT_SECRET = 'wadojo-super-secret-key-2026';

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

async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[Baileys] Menggunakan WA Web v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      // Gunakan profil Windows Desktop agar menyerupai browser biasa
      browser: Browsers.windows('Desktop'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      retryRequestDelayMs: 3000,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQr = await qrcode.toDataURL(qr);
        connectionStatus = 'connecting';
        console.log('[Baileys] QR code baru berhasil di-generate.');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionStatus = 'disconnected';
        currentQr = null;
        isConnecting = false;
        console.log(`[Baileys] Sesi terputus (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => {
            connectToWhatsApp();
          }, 5000);
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        currentQr = null;
        isConnecting = false;
        console.log('[Baileys] WhatsApp berhasil terhubung aktif!');
      }
    });
  } catch (err) {
    console.error('[Baileys Init Error]:', err);
    isConnecting = false;
    setTimeout(() => {
      connectToWhatsApp();
    }, 5000);
  }
}

connectToWhatsApp();

// API Login
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

// API QR
app.get('/api/qr', (req, res) => {
  res.json({
    status: connectionStatus,
    qr: currentQr
  });
});

// API Send Pesan
app.post('/api/send', async (req, res) => {
  const { phone, message, imageBase64, buttons } = req.body;

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({
      success: false,
      message: 'WhatsApp belum terhubung. Harap scan QR code terlebih dahulu.'
    });
  }

  if (!phone) {
    return res.status(400).json({ success: false, message: 'Nomor tujuan wajib diisi.' });
  }

  try {
    let cleanPhone = phone.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) {
      cleanPhone = '62' + cleanPhone.slice(1);
    }
    const jid = `${cleanPhone}@s.whatsapp.net`;

    let finalMessage = message || '';
    if (buttons && Array.isArray(buttons) && buttons.length > 0) {
      const buttonLinks = buttons
        .filter((b) => b.text && b.url)
        .map((b) => `👉 ${b.text}: ${b.url}`)
        .join('\n');

      if (buttonLinks) {
        finalMessage += `\n\n${buttonLinks}`;
      }
    }

    if (imageBase64) {
      const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      await sock.sendMessage(jid, {
        image: buffer,
        caption: finalMessage
      });
    } else {
      await sock.sendMessage(jid, { text: finalMessage });
    }

    return res.json({ success: true, message: 'Pesan berhasil terkirim' });
  } catch (error) {
    console.error('[Send Message Error]:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Server WA Blast Backend aktif di http://localhost:${PORT}`);
});