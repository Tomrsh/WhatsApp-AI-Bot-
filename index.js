const { makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const axios = require('axios');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// --- CONFIGURATION ---
const firebaseConfig = {
    apiKey: "AIzaSyAb7V8Xxg5rUYi8UKChEd3rR5dglJ6bLhU",
    databaseURL: "https://t2-storage-4e5ca-default-rtdb.firebaseio.com",
};
const MY_URL = "https://your-app-name.onrender.com";

let sessions = {};

// 1. Anti-Sleep Logic
setInterval(() => { axios.get(MY_URL).catch(() => {}); }, 4 * 60 * 1000);

// 2. Simple Chat Brain Parser
async function getChatReply(incomingMsg) {
    try {
        const path = './chat.txt';
        if (!await fs.pathExists(path)) return "Assistant: Busy hoon bhai. 😊";
        
        const data = await fs.readFile(path, 'utf8');
        const lines = data.split('\n');
        const cleanMsg = incomingMsg.toLowerCase().trim();

        for (let line of lines) {
            if (line.includes('User:') && line.includes('AI:')) {
                let parts = line.split('AI:');
                let userPart = parts[0].replace('User:', '').trim().toLowerCase();
                let aiPart = parts[1].trim();

                if (cleanMsg.includes(userPart) || userPart.includes(cleanMsg)) {
                    return aiPart;
                }
            }
        }
    } catch (e) { console.log("Brain Error"); }
    return "Ji, main thodi der mein batata hoon. 😊";
}

// 3. Multi-Instance WhatsApp Starter
async function startInstance(userId) {
    const sessionDir = `./sessions/${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    let config = { isAIEnabled: true, groupEnabled: false, customReplies: {} };
    try {
        const res = await axios.get(`${firebaseConfig.databaseURL}/users/${userId}.json?auth=${firebaseConfig.apiKey}`);
        if(res.data) config = res.data;
    } catch(e) {}

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Master-SaaS", "Chrome", "1.0.0"]
    });

    sessions[userId] = { sock, config, bomberActive: false };

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (up) => {
        if (up.qr) io.to(userId).emit('qr', await QRCode.toDataURL(up.qr));
        if (up.connection === 'open') io.to(userId).emit('ready', config);
        if (up.connection === 'close' && up.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) startInstance(userId);
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe || !sessions[userId].config.isAIEnabled) return;
        
        const sender = m.key.remoteJid;
        const msgText = (m.message.conversation || m.message.extendedTextMessage?.text || "").toLowerCase();
        
        if (sender.endsWith('@g.us') && !sessions[userId].config.groupEnabled) return;

        // Custom Priority Reply Check
        const cleanNum = sender.replace(/[^0-9]/g, '');
        if (sessions[userId].config.customReplies[cleanNum]) {
            return await sock.sendMessage(sender, { text: sessions[userId].config.customReplies[cleanNum] });
        }

        // AI Brain Reply
        const reply = await getChatReply(msgText);
        await delay(1500);
        await sock.sendMessage(sender, { text: reply });
    });
}

// --- APIs ---
app.get('/dashboard/:userId', (req, res) => res.sendFile(__dirname + '/public/dashboard.html'));

app.post('/api/save/:userId', async (req, res) => {
    const userId = req.params.userId;
    sessions[userId].config = req.body;
    await axios.put(`${firebaseConfig.databaseURL}/users/${userId}.json?auth=${firebaseConfig.apiKey}`, req.body);
    res.json({ success: true });
});

app.post('/api/bomber/:userId', async (req, res) => {
    const { action, number, message, delayTime, count } = req.body;
    const userId = req.params.userId;
    if (action === 'start') {
        sessions[userId].bomberActive = true;
        for (let i = 0; i < count && sessions[userId].bomberActive; i++) {
            await sessions[userId].sock.sendMessage(number + "@s.whatsapp.net", { text: message });
            await delay(delayTime * 1000);
        }
    } else { sessions[userId].bomberActive = false; }
    res.json({ success: true });
});

app.post('/api/timer/:userId', (req, res) => {
    const { number, message, time, unit } = req.body;
    const userId = req.params.userId;
    let ms = { 'sec': 1000, 'min': 60000, 'hour': 3600000, 'day': 86400000 }[unit] * time;
    setTimeout(() => { 
        if(sessions[userId]) sessions[userId].sock.sendMessage(number + "@s.whatsapp.net", { text: message }); 
    }, ms);
    res.json({ success: true });
});

io.on('connection', (socket) => {
    socket.on('init', (userId) => {
        socket.join(userId);
        if (!sessions[userId]) startInstance(userId);
        else if (sessions[userId].sock.user) socket.emit('ready', sessions[userId].config);
    });
});

server.listen(process.env.PORT || 3000, () => console.log("System Running 24/7"));
