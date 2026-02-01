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

// ================= USER FIREBASE CONFIG =================
const firebaseConfig = {
  apiKey: "AIzaSyAb7V8Xxg5rUYi8UKChEd3rR5dglJ6bLhU",
  databaseURL: "https://t2-storage-4e5ca-default-rtdb.firebaseio.com",
};
// ========================================================

app.use(express.json());
app.use(express.static('public'));

let sock;
let botConfig = {
    isAIEnabled: true,
    groupEnabled: false,
    customReplies: {}
};

// --- FIREBASE OPERATIONS ---
const getDbUrl = (path) => `${firebaseConfig.databaseURL}/${path}.json?auth=${firebaseConfig.apiKey}`;

async function syncFromFirebase() {
    try {
        const res = await axios.get(getDbUrl('bot_settings'));
        if (res.data) {
            botConfig = { ...botConfig, ...res.data };
            console.log("📥 Settings Loaded from Firebase");
        }
    } catch (e) { console.log("Firebase Connection Initialized..."); }
}

async function saveToFirebase() {
    try {
        await axios.put(getDbUrl('bot_settings'), botConfig);
    } catch (e) { console.error("Firebase Sync Failed!"); }
}

// --- CORE BOT LOGIC ---
async function startWA() {
    await syncFromFirebase();
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ["Master-Admin", "Chrome", "1.1.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            const url = await QRCode.toDataURL(qr);
            io.emit('qr', url);
        }
        if (connection === 'open') {
            io.emit('connected');
            console.log("✅ Dashboard Active!");
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startWA();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe || !botConfig.isAIEnabled) return;

        const sender = m.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        const cleanNumber = sender.replace(/[^0-9]/g, '');

        if (isGroup && !botConfig.groupEnabled) return;

        await sock.sendPresenceUpdate('composing', sender);
        await delay(1500);

        // PRIORITY LOGIC: Check Custom vs Default
        if (botConfig.customReplies && botConfig.customReplies[cleanNumber]) {
            // Agar specific reply hai toh default assistant msg skip ho jayega
            return await sock.sendMessage(sender, { text: botConfig.customReplies[cleanNumber] }, { quoted: m });
        }

        // DEFAULT REY (Agar custom list me nahi hai)
        const defaultMsg = "Sir abhi unavailable hain. Main unki assistant bol rahi hoon, aapka message note kar liya hai. 😊";
        await sock.sendMessage(sender, { text: defaultMsg }, { quoted: m });
    });
}

// APIs
app.post('/api/update-config', async (req, res) => {
    botConfig = { ...botConfig, ...req.body };
    await saveToFirebase();
    res.json({ success: true });
});

app.post('/api/add-custom', async (req, res) => {
    const { number, reply } = req.body;
    if(!botConfig.customReplies) botConfig.customReplies = {};
    botConfig.customReplies[number] = reply;
    await saveToFirebase();
    res.json({ success: true });
});

app.get('/api/get-config', (req, res) => res.json(botConfig));

startWA();
server.listen(3000, () => console.log("🚀 Server: http://localhost:3000"));
