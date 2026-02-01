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

// ================= FIREBASE WEB CONFIG =================
const firebaseConfig = {
  apiKey: "AIzaSyAb7V8Xxg5rUYi8UKChEd3rR5dglJ6bLhU",
  databaseURL: "https://t2-storage-4e5ca-default-rtdb.firebaseio.com",
};
const dbUrl = (path) => `${firebaseConfig.databaseURL}/${path}.json?auth=${firebaseConfig.apiKey}`;
// ========================================================

app.use(express.json());
app.use(express.static('public'));

let sock;
let isConnected = false;
let bomberActive = false;
let botConfig = { 
    isAIEnabled: true, 
    groupEnabled: false, 
    customReplies: {} 
};

// --- SMART REPLY ENGINE (Old Feature) ---
function getSmartReply(text) {
    const msg = text.toLowerCase();
    if (/hi|hello|hey|hlo/.test(msg)) return "Hello! Sir abhi busy hain, main unki assistant bol rahi hoon. 😊";
    if (/busy|kaha ho|call/.test(msg)) return "Sir abhi unavailable hain. Aap message chhod dijiye. ✨";
    return "Ji, maine note kar liya hai. Sir aate hi check kar lenge. 😊";
}

async function syncSettings() {
    try {
        const res = await axios.get(dbUrl('bot_config'));
        if (res.data) botConfig = { ...botConfig, ...res.data };
    } catch (e) { console.log("Firebase sync init..."); }
}

async function saveSettings() {
    await axios.put(dbUrl('bot_config'), botConfig);
}

async function startWA() {
    await syncSettings();
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Master-Pro-Panel", "Chrome", "1.1.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) io.emit('qr', await QRCode.toDataURL(qr));
        if (connection === 'open') {
            isConnected = true;
            io.emit('connected', botConfig);
        }
        if (connection === 'close') {
            isConnected = false;
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) startWA();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe || !botConfig.isAIEnabled) return;

        const sender = m.key.remoteJid;
        const cleanNumber = sender.replace(/[^0-9]/g, '');
        const msgText = m.message.conversation || m.message.extendedTextMessage?.text || "";

        if (sender.endsWith('@g.us') && !botConfig.groupEnabled) return;

        // PRIORITY CHECK: Custom Reply First
        if (botConfig.customReplies && botConfig.customReplies[cleanNumber]) {
            await delay(1000);
            return await sock.sendMessage(sender, { text: botConfig.customReplies[cleanNumber] }, { quoted: m });
        }

        // SMART REPLY Second
        const reply = getSmartReply(msgText);
        await delay(1500);
        await sock.sendMessage(sender, { text: reply }, { quoted: m });
    });
}

// --- NEW APIs: TIMER & BOMBER ---
app.post('/api/timer-msg', (req, res) => {
    const { number, message, time, unit } = req.body;
    let ms = { 'sec': 1, 'min': 60, 'hour': 3600, 'day': 86400 }[unit] * time * 1000;
    setTimeout(async () => {
        if (isConnected) await sock.sendMessage(number + "@s.whatsapp.net", { text: message });
    }, ms);
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
        bomberActive = false;
    } else { bomberActive = false; }
    res.json({ success: true });
});

app.get('/api/get-config', (req, res) => res.json({ ...botConfig, isConnected }));
app.post('/api/update-config', async (req, res) => {
    botConfig = { ...botConfig, ...req.body };
    await saveSettings();
    res.json({ success: true });
});

startWA();
server.listen(3000, () => console.log("🚀 Server running on http://localhost:3000"));
