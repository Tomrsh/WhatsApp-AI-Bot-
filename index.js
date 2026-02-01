const { makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ================= FIREBASE CONFIG =================
const firebaseConfig = {
  apiKey: "AIzaSyAb7V8Xxg5rUYi8UKChEd3rR5dglJ6bLhU",
  databaseURL: "https://t2-storage-4e5ca-default-rtdb.firebaseio.com",
};
const dbUrl = (path) => `${firebaseConfig.databaseURL}/${path}.json?auth=${firebaseConfig.apiKey}`;
// ===================================================

app.use(express.json());
app.use(express.static('public'));

let sock;
let bomberActive = false;
let botConfig = { 
    isAIEnabled: true, 
    groupEnabled: false, 
    customReplies: {} 
};

// --- SYNC DATA WITH FIREBASE ---
async function syncFromFirebase() {
    try {
        const res = await axios.get(dbUrl('bot_config'));
        if (res.data) botConfig = { ...botConfig, ...res.data };
        console.log("📥 Firebase Data Synced");
    } catch (e) { console.log("Initializing New Firebase Node..."); }
}

async function saveToFirebase() {
    await axios.put(dbUrl('bot_config'), botConfig);
}

// --- SMART REPLY LOGIC ---
function getSmartReply(text) {
    const msg = text.toLowerCase();
    if (/hi|hello|hey|hlo/.test(msg)) return "Hello! Sir abhi busy hain, main unki assistant bol rahi hoon. 😊";
    if (/busy|kaha ho|call|kya kar/.test(msg)) return "Sir abhi unavailable hain. Aap message chhod dijiye, main unhe bata dungi. ✨";
    return "Theek hai, maine aapka message note kar liya hai. 😊";
}

async function startWA() {
    await syncFromFirebase();
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Pro-Admin", "Chrome", "1.1.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) io.emit('qr', await QRCode.toDataURL(qr));
        if (connection === 'open') {
            console.log("✅ Bot Online");
            io.emit('connected', botConfig);
        }
        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) startWA();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe || !botConfig.isAIEnabled) return;

        const sender = m.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        const cleanNumber = sender.replace(/[^0-9]/g, '');
        const msgText = m.message.conversation || m.message.extendedTextMessage?.text || "";

        if (isGroup && !botConfig.groupEnabled) return;

        // 1. Priority Custom Reply
        if (botConfig.customReplies && botConfig.customReplies[cleanNumber]) {
            await delay(1000);
            return await sock.sendMessage(sender, { text: botConfig.customReplies[cleanNumber] }, { quoted: m });
        }

        // 2. Smart AI Reply
        const reply = getSmartReply(msgText);
        await delay(1500);
        await sock.sendMessage(sender, { text: reply }, { quoted: m });
    });
}

// --- API ENDPOINTS ---
app.get('/api/config', (req, res) => res.json(botConfig));

app.post('/api/update-config', async (req, res) => {
    botConfig = { ...botConfig, ...req.body };
    await saveToFirebase();
    io.emit('configUpdated', botConfig);
    res.json({ success: true });
});

app.post('/api/timer-msg', (req, res) => {
    const { number, message, time, unit } = req.body;
    let multiplier = { 'sec': 1000, 'min': 60000, 'hour': 3600000, 'day': 86400000 }[unit];
    setTimeout(async () => {
        if (sock) await sock.sendMessage(number + "@s.whatsapp.net", { text: message });
    }, time * multiplier);
    res.json({ success: true });
});

app.post('/api/bomber', async (req, res) => {
    const { action, number, message, delayTime, count } = req.body;
    if (action === 'start') {
        bomberActive = true;
        for (let i = 0; i < count && bomberActive; i++) {
            await sock.sendMessage(number + "@s.whatsapp.net", { text: message });
            await delay(delayTime * 1000);
        }
    } else { bomberActive = false; }
    res.json({ success: true });
});

startWA();
server.listen(3000, () => console.log("Server running on port 3000"));
