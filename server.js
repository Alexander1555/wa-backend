const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();

// Konfigurasi limit payload besar agar bisa menerima lampiran gambar base64
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const JWT_SECRET = 'wadojo-super-secret-key-2026';

// Data kredensial pengguna statis
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

// State Baileys WhatsApp
let sock = null;
let currentQr = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'

// Inisialisasi Klien Baileys
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['WA-Dojo Blaster', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQr = await qrcode.toDataURL(qr);
        connectionStatus = 'connecting';
        console.log('[Baileys] QR code berhasil di-generate.');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionStatus = 'disconnected';
        currentQr = null;
        console.log('[Baileys] Sesi terputus. Mencoba rekoneksi:', shouldReconnect);

        if (shouldReconnect) {
          connectToWhatsApp();
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        currentQr = null;
        console.log('[Baileys] Terhubung ke WhatsApp.');
      }
    });
  } catch (err) {
    console.error('[Baileys Init Error]:', err);
  }
}

// Mulai Baileys saat server start
connectToWhatsApp();

// ==========================================
// ENDPOINT API
// ==========================================

// 1. Endpoint Autentikasi Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS.find((u) => u.username === username);

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ success: false, message: 'Username atau password salah' });
  }

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
    expiresIn: '7d'
  });

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

// 2. Endpoint Mengambil Status Sesi WhatsApp & QR Code
app.get('/api/qr', (req, res) => {
  res.json({
    status: connectionStatus,
    qr: currentQr
  });
});

// 3. Endpoint Kirim Pesan Realtime
app.post('/api/send', async (req, res) => {
  const { phone, message, imageBase64, buttons } = req.body;

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({
      success: false,
      message: 'Koneksi WhatsApp belum terhubung. Silakan scan QR code terlebih dahulu.'
    });
  }

  if (!phone) {
    return res.status(400).json({ success: false, message: 'Nomor tujuan wajib diisi.' });
  }

  try {
    // Normalisasi format nomor WhatsApp
    let cleanPhone = phone.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) {
      cleanPhone = '62' + cleanPhone.slice(1);
    }
    const jid = `${cleanPhone}@s.whatsapp.net`;

    // Susun pesan teks dan tambahkan teks link button jika ada
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

    // Jika mengirim gambar beserta caption
    if (imageBase64) {
      const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      await sock.sendMessage(jid, {
        image: buffer,
        caption: finalMessage
      });
    } else {
      // Kirim teks saja
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
  console.log(`Server WA-Dojo Blaster Backend berjalan di port ${PORT}`);
});