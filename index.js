// index.js
require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');

// --- SETUP SERVER ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURATION ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let sock;
let isAIEnabled = false;

// --- AI LOGIC ---
const systemPrompt = `
You are a smart Personal Assistant for my WhatsApp.
My Boss is currently unavailable.
Reply politely in Hinglish (Hindi + English).
Example: "Hello, Sir abhi busy hain. Bataye kya kaam tha?"
Do not be rude. Keep replies short.
`;

async function getAIResponse(userMsg) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMsg }
            ]
        });
        return response.choices[0].message.content;
    } catch (e) {
        console.log("OpenAI Error:", e.message);
        return "Sir abhi busy hain, baad me reply karenge.";
    }
}

// --- WHATSAPP LOGIC (BAILEYS) ---
async function connectToWhatsApp() {
    // Auth State (Session save karne ke liye)
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Terminal me bhi QR dikhega
        logger: pino({ level: 'silent' }), // Logs clean rakhne ke liye
        browser: ["AI Assistant", "Chrome", "1.0.0"]
    });

    // Save Credentials automatically
    sock.ev.on('creds.update', saveCreds);

    // Connection Updates (QR, Connect, Disconnect)
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("QR Code received!");
            // QR Code ko Image URL me convert karke Frontend bhejo
            QRCode.toDataURL(qr, (err, url) => {
                io.emit('qr_code', url);
                io.emit('status', 'Scan QR Code now');
            });
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp Connected!');
            io.emit('status', 'Connected');
            io.emit('ready', true);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            io.emit('status', 'Disconnected. Reconnecting...');
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        }
    });

    // Message Handling (AI Reply)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return; // Ignore self messages

        const remoteJid = msg.key.remoteJid;
        // Text nikalne ka logic (Baileys me thoda complex hota hai)
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (isAIEnabled && text) {
            console.log(`Msg from ${remoteJid}: ${text}`);
            
            // Typing status bhejo
            await sock.sendPresenceUpdate('composing', remoteJid);
            
            // AI Response
            const reply = await getAIResponse(text);
            
            // Reply Send Karo
            await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
        }
    });
}

// Start WhatsApp Logic
connectToWhatsApp();

// --- API ROUTES ---

// Toggle AI
app.post('/api/toggle-ai', (req, res) => {
    isAIEnabled = req.body.enabled;
    console.log("AI Mode:", isAIEnabled);
    res.json({ success: true, status: isAIEnabled });
});

// Timer Message
app.post('/api/schedule-msg', async (req, res) => {
    const { number, message, delaySeconds } = req.body;
    
    // Number format (1234567890 -> 911234567890@s.whatsapp.net)
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

    console.log(`Scheduling msg for ${jid} in ${delaySeconds}s`);

    setTimeout(async () => {
        if(sock) {
            await sock.sendMessage(jid, { text: message });
            console.log("Timer Message Sent!");
        }
    }, delaySeconds * 1000);

    res.json({ success: true });
});

// Server Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
