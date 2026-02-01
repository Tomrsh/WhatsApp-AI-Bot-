const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

let sock;
let isAIEnabled = false;
const sessionPath = './auth_info_baileys';
const sessionState = new Map(); // Context yaad rakhne ke liye

// --- NATURAL ASSISTANT LOGIC (NO AI) ---
function getNaturalReply(sender, text) {
    const msg = text.toLowerCase();
    const state = sessionState.get(sender) || { introDone: false };
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    // Jab user koi kaam bataye
    if (/bata dena|bol dena|infom|message|baat|kehna|sun lo/.test(msg)) {
        sessionState.set(sender, { introDone: true });
        return pick([
            "Ji bilkul, main Sir ko inform kar dungi. 😊",
            "Theek hai, maine note kar liya hai. Sir aate hi check kar lenge.",
            "Done! Aapka message Sir tak pahunch jayega. ✨"
        ]);
    }

    // Pehla Message / Greetings
    if (/hi|hello|hey|hlo|salam/.test(msg)) {
        if (!state.introDone) {
            sessionState.set(sender, { introDone: true });
            return "Hello! Sir abhi busy hain, isliye main unka account manage kar rahi hoon. Batayein kya kaam hai? 😊";
        } else {
            return "Ji batayein, main sun rahi hoon. ✨";
        }
    }

    // Status Poochna
    if (/busy|kaha hai|kya kar raha|call/.test(msg)) {
        return "Sir abhi unavailable hain. Main unki assistant hoon, aapka message un tak pahuncha sakti hoon. 😊";
    }

    // Chote Replies
    if (msg.length < 5 || /acha|ok|okay|thik|hm/.test(msg)) {
        return pick(["Ji.", "Theek hai. 😊", "Ji, aur kuch?"]);
    }

    return "Theek hai, main ye Sir ko bata dungi. ✨";
}

async function connectToWA() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ["Pro-Assistant", "Chrome", "1.1.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            const url = await QRCode.toDataURL(qr);
            io.emit('qr', url);
        }
        if (connection === 'open') {
            console.log("✅ WhatsApp Connected!");
            io.emit('connected');
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWA();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe || !isAIEnabled) return;
        const sender = m.key.remoteJid;
        const msgText = m.message.conversation || m.message.extendedTextMessage?.text || "";

        await sock.sendPresenceUpdate('composing', sender);
        const reply = getNaturalReply(sender, msgText);
        
        setTimeout(() => {
            sock.sendMessage(sender, { text: reply }, { quoted: m });
        }, 1500);
    });
}

// --- DEVICE ID APIs ---

// 1. Device ID se login karna
app.post('/api/login-by-id', async (req, res) => {
    const { deviceId } = req.body;
    try {
        const decodedData = Buffer.from(deviceId, 'base64').toString();
        const credsJson = JSON.parse(decodedData);
        
        await fs.ensureDir(sessionPath);
        await fs.writeJson(`${sessionPath}/creds.json`, credsJson);
        
        if (sock) {
            sock.end();
            sock = null;
        }
        setTimeout(() => connectToWA(), 2000);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: "Invalid Device ID Format!" });
    }
});

// 2. Current Session ki ID nikalna
app.get('/api/export-id', async (req, res) => {
    try {
        const creds = await fs.readJson(`${sessionPath}/creds.json`);
        const encoded = Buffer.from(JSON.stringify(creds)).toString('base64');
        res.json({ deviceId: encoded });
    } catch (err) {
        res.status(404).json({ error: "No session found. Please scan QR first." });
    }
});

app.post('/api/toggle-ai', (req, res) => { isAIEnabled = req.body.status; res.json({ success: true }); });
app.get('/api/status', (req, res) => res.json({ connected: !!(sock?.user), ai: isAIEnabled }));

connectToWA();
server.listen(3000, () => console.log("🚀 Server: http://localhost:3000"));
