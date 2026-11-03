import express from 'express';
import cors from 'cors';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  delay
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;
const sessionPath = './sessions/main_sender';

if (!fs.existsSync(sessionPath)) {
  fs.mkdirSync(sessionPath, { recursive: true });
}

let sock = null;
let currentQrBase64 = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let connectedNumber = null;

// Inisialisasi koneksi WhatsApp Baileys
async function connectToWhatsApp() {
  connectionStatus = 'connecting';
  currentQrBase64 = null;

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Jika ada string QR, ubah ke gambar Base64 agar bisa ditampilkan di Frontend
    if (qr) {
      try {
        currentQrBase64 = await QRCode.toDataURL(qr);
        connectionStatus = 'disconnected';
      } catch (err) {
        console.error('Gagal generate QR Code gambar:', err);
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      currentQrBase64 = null;
      connectedNumber = sock.user?.id ? sock.user.id.split(':')[0] : 'Aktif';
      console.log(`✅ [WhatsApp Gateway] Berhasil terhubung! Nomor: +${connectedNumber}`);
    } else if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connectionStatus = 'disconnected';
      connectedNumber = null;

      console.log(`⚠️ Koneksi terputus (status code: ${statusCode}). Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        connectToWhatsApp();
      } else {
        // Jika status logged out, bersihkan session lama
        currentQrBase64 = null;
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (e) {}
      }
    }
  });
}

// Mulai inisialisasi koneksi awal
connectToWhatsApp();

// 1. Endpoint Cek Status & Ambil QR Code
app.get('/api/wa/status', (req, res) => {
  res.json({
    status: connectionStatus,
    qrImage: currentQrBase64,
    phoneNumber: connectedNumber,
  });
});

// 2. Endpoint Trigger Generate / Reset QR
app.post('/api/wa/restart', async (req, res) => {
  try {
    if (sock) {
      sock.end();
    }
    // Hapus sesi lama agar menghasilkan QR baru
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    } catch (e) {}

    await connectToWhatsApp();
    res.json({ message: 'Gateway di-reset. Menghasilkan QR baru...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Endpoint Putuskan Sesi (Logout)
app.post('/api/wa/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    } catch (e) {}
    connectionStatus = 'disconnected';
    connectedNumber = null;
    currentQrBase64 = null;
    res.json({ message: 'Berhasil logout dari WhatsApp.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Endpoint Eksekusi Blast Pesan
app.post('/api/blast/start', async (req, res) => {
  const { recipients, message, mediaUrl, links, minDelay = 5, maxDelay = 10 } = req.body;

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ error: 'Nomor WhatsApp belum terhubung! Silakan scan QR terlebih dahulu di menu Setting.' });
  }

  if (!recipients || !recipients.length || !message) {
    return res.status(400).json({ error: 'Nomor tujuan dan isi pesan wajib diisi!' });
  }

  res.json({
    status: 'started',
    totalRecipients: recipients.length,
    message: 'Proses blast pengiriman pesan telah dimulai di latar belakang.'
  });

  // Background Worker
  (async () => {
    for (let i = 0; i < recipients.length; i++) {
      let phone = recipients[i].replace(/[^0-9]/g, '');
      if (phone.startsWith('0')) phone = '62' + phone.slice(1);
      const jid = `${phone}@s.whatsapp.net`;

      try {
        let parsedMessage = message.replace(/\{\{nomor\}\}/gi, phone);
        if (links && Array.isArray(links)) {
          links.forEach((lnk, idx) => {
            const tag = new RegExp(`\\{\\{link${idx + 1}\\}\\}`, 'gi');
            parsedMessage = lnk.enabled ? parsedMessage.replace(tag, lnk.url) : parsedMessage.replace(tag, '');
          });
        }

        // Simulasi Mengetik
        await sock.sendPresenceUpdate('composing', jid);
        await delay(2000);

        if (mediaUrl) {
          await sock.sendMessage(jid, {
            image: { url: mediaUrl },
            caption: parsedMessage.trim()
          });
        } else {
          await sock.sendMessage(jid, { text: parsedMessage.trim() });
        }

        await sock.sendPresenceUpdate('paused', jid);
        console.log(`[Blast Sukses] Terkirim ke +${phone}`);
      } catch (err) {
        console.error(`[Blast Gagal] Gagal kirim ke +${phone}:`, err.message);
      }

      // Delay acak
      const waitTime = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay) * 1000;
      await delay(waitTime);
    }
  })();
});

app.listen(PORT, () => {
  console.log(`🚀 WA Blast Backend aktif di http://localhost:${PORT}`);
});