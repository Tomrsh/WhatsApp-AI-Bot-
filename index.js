const { makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
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
const sessionState = new Map();

// --- NATURAL ASSISTANT ENGINE ---
function getNaturalReply(sender, text) {
    const msg = text.toLowerCase();
    if (!sessionState.has(sender)) {
        sessionState.set(sender, { introDone: false });
    }
    const state = sessionState.get(sender);
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    // 1. Message Notification Logic
    if (/bata dena|bol dena|infom|message|baat|kehna|sun lo|keh do/.test(msg)) {
        state.introDone = true;
        return pick([
            "Ji bilkul, main Sir ko inform kar dungi. 😊",
            "Theek hai, maine note kar liya hai. Sir aate hi check kar lenge.",
            "Done! Aapka message Sir tak pahunch jayega. ✨"
        ]);
    }

    // 2. Greetings
    if (/hi|hello|hey|hlo|salam/.test(msg)) {
        if (!state.introDone) {
            state.introDone = true;
            return "Hello! Sir abhi busy hain, isliye main unka account manage kar rahi hoon. Batayein kya kaam hai? 😊";
        } else {
            return "Ji batayein, main sun rahi hoon. ✨";
        }
    }

    // 3. Status
    if (/busy|kaha hai|kya kar raha|call/.test(msg)) {
        return "Sir abhi unavailable hain. Main unki assistant hoon, aapka message un tak pahuncha sakti hoon. 😊";
    }

    // 4. Short Replies
    if (msg.length < 5 || /acha|ok|okay|thik|hm/.test(msg)) {
        return pick(["Ji.", "Theek hai. 😊", "Ji, aur kuch?"]);
    }

    return "Theek hai, maine note kar liya hai. ✨";
}

async function startWA() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Pro-Assistant", "Chrome", "1.1.0"],
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(message.buttonsMessage || message.templateMessage || message.listMessage);
            if (requiresPatch) {
                message = { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, ...message } } };
            }
            return message;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            const url = await QRCode.toDataURL(qr);
            io.emit('qr', url);
        }
        if (connection === 'open') {
            console.log("✅ Assistant is Online!");
            io.emit('connected');
        }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) startWA();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe || !isAIEnabled) return;

        const sender = m.key.remoteJid;
        const msgText = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || "";

        if (!msgText) return;

        // Artificial Typing Delay
        await sock.sendPresenceUpdate('composing', sender);
        await delay(1500); 

        const reply = getNaturalReply(sender, msgText);
        await sock.sendMessage(sender, { text: reply }, { quoted: m });
    });
}

// --- APIs ---
app.post('/api/login-by-id', async (req, res) => {
    try {
        const { deviceId } = req.body;
        const decoded = Buffer.from(deviceId, 'base64').toString();
        const creds = JSON.parse(decoded);
        
        await fs.ensureDir(sessionPath);
        await fs.writeJson(`${sessionPath}/creds.json`, creds);
        
        res.json({ success: true });
        console.log("🔄 Session ID Injected. Restarting...");
        process.exit(0); // Server automatic restart ho jayega PM2 ya nodemon se
    } catch (err) {
        res.status(400).json({ error: "Invalid ID" });
    }
});

app.get('/api/export-id', async (req, res) => {
    try {
        const creds = await fs.readJson(`${sessionPath}/creds.json`);
        const encoded = Buffer.from(JSON.stringify(creds)).toString('base64');
        res.json({ deviceId: encoded });
    } catch (err) {
        res.status(404).json({ error: "No Session" });
    }
});

app.post('/api/toggle-ai', (req, res) => {
    isAIEnabled = req.body.status;
    res.json({ success: true });
});

app.get('/api/status', (req, res) => {
    res.json({ connected: !!(sock?.user), ai: isAIEnabled });
});

startWA();
server.listen(3000, () => console.log("🚀 Server: http://localhost:3000"));
