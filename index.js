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
const dbUrl = (path) => `${firebaseConfig.databaseURL}/${path}.json?auth=${firebaseConfig.apiKey}`;
// ========================================================

app.use(express.json());
app.use(express.static('public'));

let sock;
let isConnected = false;
let botConfig = { 
    isAIEnabled: true, 
    groupEnabled: false, 
    customReplies: {} 
};

// --- SMART REPLY ENGINE ---
function getSmartReply(text) {
    const msg = text.toLowerCase();
    
    // 1. Greetings
    if (/hi|hello|hey|hlo|salam|namaste/.test(msg)) {
        return "Hello! Sir abhi busy hain, main unki assistant bol rahi hoon. Batayein kya kaam hai? 😊";
    }
    // 2. Status / Busy Inquiry
    if (/busy|kya kar rahe|kaha ho|call|busy ho/.test(msg)) {
        return "Sir abhi unavailable hain. Aap apna message chhod dijiye, main unhe inform kar dungi. ✨";
    }
    // 3. Informing / Message Leaving
    if (/bata dena|bol dena|infom|message|baat|kehna|sun lo/.test(msg)) {
        return "Ji bilkul, maine note kar liya hai. Sir aate hi check kar lenge. 😊";
    }
    // 4. Short / Casual
    if (msg.length < 5 || /acha|ok|okay|thik|hm/.test(msg)) {
        return "Ji, aur kuch kehna hai aapko?";
    }

    // Default Fallback
    return "Theek hai, main ye Sir ko bata dungi. 😊";
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
        browser: ["Master-Assistant", "Chrome", "1.1.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) io.emit('qr', await QRCode.toDataURL(qr));
        if (connection === 'open') {
            isConnected = true;
            io.emit('connected', botConfig);
            console.log("✅ Assistant Online!");
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

        await sock.sendPresenceUpdate('composing', sender);
        await delay(1500);

        // --- PRIORITY 1: CUSTOM REPLY ---
        if (botConfig.customReplies && botConfig.customReplies[cleanNumber]) {
            return await sock.sendMessage(sender, { text: botConfig.customReplies[cleanNumber] }, { quoted: m });
        }

        // --- PRIORITY 2: SMART REPLY ---
        const reply = getSmartReply(msgText);
        await sock.sendMessage(sender, { text: reply }, { quoted: m });
    });
}

// APIs
app.get('/api/get-config', (req, res) => res.json({ ...botConfig, isConnected }));
app.post('/api/update-config', async (req, res) => {
    botConfig = { ...botConfig, ...req.body };
    await saveSettings();
    res.json({ success: true });
});

startWA();
server.listen(3000, () => console.log("🚀 Server: http://localhost:3000"));
