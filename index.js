const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ================= CONFIGURATION =================
const firebaseConfig = {
  apiKey: "AIzaSyAb7V8Xxg5rUYi8UKChEd3rR5dglJ6bLhU",
  databaseURL: "https://t2-storage-4e5ca-default-rtdb.firebaseio.com",
};
// =================================================

app.use(express.json());
app.use(express.static('public'));

let sock;
let isAIEnabled = false;
const sessionState = new Map(); // Yaad rakhne ke liye ki baat kahan tak pahunchi

// --- IMPROVED NATURAL ASSISTANT LOGIC ---
function getNaturalReply(sender, text) {
    const msg = text.toLowerCase();
    const state = sessionState.get(sender) || { introDone: false, nameAsked: false };
    
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    // 1. Agar user ne message/naam bataya (Common phrases)
    if (/bata dena|bol dena|infom|message|baat|kehna/.test(msg)) {
        sessionState.set(sender, { ...state, introDone: true });
        return pick([
            "Ji bilkul, main Sir ko inform kar dungi. 😊",
            "Theek hai, maine note kar liya hai. Sir aate hi check kar lenge.",
            "Done! Aapka message Sir tak pahunch jayega. ✨"
        ]);
    }

    // 2. Greetings (Sirf pehli baar intro degi)
    if (/hi|hello|hey|hlo|salam/.test(msg)) {
        if (!state.introDone) {
            sessionState.set(sender, { ...state, introDone: true });
            return "Hello! Sir abhi busy hain, isliye main unka account manage kar rahi hoon. Batayein kya kaam hai? 😊";
        } else {
            return "Ji batayein, main sun rahi hoon. ✨";
        }
    }

    // 3. Status/Busy sawal
    if (/busy|kaha hai|kya kar raha|call/.test(msg)) {
        return pick([
            "Sir abhi ek meeting mein hain, isliye phone nahi utha payenge. 😊",
            "Filhal toh wo busy hain. Aapka koi urgent kaam hai toh mujhe bata dijiye.",
            "Sir unavailable hain. Main unki assistant hoon, aapka message un tak pahuncha sakti hoon."
        ]);
    }

    // 4. Short replies like "Acha", "Ok", "Hmm"
    if (msg.length < 5 || /acha|ok|okay|thik|hm/.test(msg)) {
        return pick(["Ji.", "Theek hai. 😊", "Ji, aur kuch?"]);
    }

    // Default Reply (Natural Flow)
    if (!state.introDone) {
        sessionState.set(sender, { ...state, introDone: true });
        return "Sir abhi unavailable hain, main unki assistant hoon. Aap apna message chhod dijiye. 😊";
    } else {
        return "Theek hai, main ye Sir ko bata dungi. Kuch aur kehna hai? ✨";
    }
}

async function connectToWA() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Pro-Assistant", "Chrome", "1.1.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) QRCode.toDataURL(qr).then(url => io.emit('qr', url));
        if (connection === 'open') io.emit('connected');
        if (connection === 'close') connectToWA();
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

// APIs
app.post('/api/toggle-ai', (req, res) => { isAIEnabled = req.body.status; res.json({ success: true }); });
app.get('/api/status', (req, res) => res.json({ connected: !!(sock?.user), ai: isAIEnabled }));

connectToWA();
server.listen(3000, () => console.log("🚀 Natural Assistant Live!"));
