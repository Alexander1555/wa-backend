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

// Konfigurasi limit payload besar untuk upload gambar base64
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
let isConnecting = false;

// Inisialisasi Klien Baileys WhatsApp
async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    
    // Ambil versi WhatsApp Web resmi terbaru secara otomatis
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[Baileys] Menggunakan WA Web v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'), // Menggunakan browser fingerprint resmi Baileys
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      retryRequestDelayMs: 3000,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false // Mencegah sinkronisasi chat lama agar sesi awal tidak drop (anti 401)
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
        console.log(`[Baileys] Koneksi terputus (status code: ${statusCode}). Reconnecting: ${shouldReconnect}`);

        if (shouldReconnect) {
          // Jeda 5 detik sebelum mencoba menyambung ulang
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

// Jalankan socket saat server menyala
connectToWhatsApp();

// ==========================================
// ENDPOINT API
// ==========================================

// 1. Endpoint Autentikasi Pengguna
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

// 2. Endpoint Mengambil Status Sesi & Gambar QR Code
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
      message: 'WhatsApp belum terhubung. Silakan lakukan scan QR code terlebih dahulu.'
    });
  }

  if (!phone) {
    return res.status(400).json({ success: false, message: 'Nomor tujuan wajib diisi.' });
  }

  try {
    // Normalisasi format nomor tujuan WhatsApp
    let cleanPhone = phone.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) {
      cleanPhone = '62' + cleanPhone.slice(1);
    }
    const jid = `${cleanPhone}@s.whatsapp.net`;

    // Validasi apakah nomor tujuan aktif terdaftar di WhatsApp
    const checkUser = await sock.onWhatsApp(jid);
    if (!checkUser || !checkUser[0] || !checkUser[0].exists) {
      return res.status(400).json({ 
        success: false, 
        message: `Nomor ${cleanPhone} tidak terdaftar di WhatsApp.` 
      });
    }

    // Susun pesan teks dan tambahkan action link button jika ada
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

    // Kirim gambar dan caption jika terdapat lampiran gambar
    if (imageBase64) {
      const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      await sock.sendMessage(jid, {
        image: buffer,
        caption: finalMessage
      });
    } else {
      // Kirim pesan teks reguler
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