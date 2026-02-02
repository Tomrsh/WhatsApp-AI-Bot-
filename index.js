const { makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const axios = require('axios');
const multer = require('multer');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

const MY_URL = "https://aapka-app-name.onrender.com"; 
const firebaseConfig = {
  apiKey: "AIzaSyAb7V8Xxg5rUYi8UKChEd3rR5dglJ6bLhU",
  databaseURL: "https://t2-storage-4e5ca-default-rtdb.firebaseio.com",
};

let sessions = {}; // Multi-user sessions storage

// --- 1. RENDER ANTI-SLEEP ---
setInterval(() => {
    axios.get(MY_URL).catch(() => {});
}, 4 * 60 * 1000);

// --- 2. SMART TXT BRAIN LOGIC ---
async function getSmartReply(userId, userMsg) {
    const filePath = `./data/${userId}/smart-reply.txt`;
    if (!await fs.pathExists(filePath)) return "Sir abhi busy hain. 😊";
    
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    userMsg = userMsg.toLowerCase();

    for (let line of lines) {
        if (line.includes('|')) {
            let [keyword, response] = line.split('|');
            if (userMsg.includes(keyword.trim().toLowerCase())) return response.trim();
        }
    }
    return "Theek hai, main note kar leta hoon. 😊";
}

// --- 3. MULTI-USER SESSION START ---
async function startSession(userId) {
    const sessionDir = `./sessions/${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    // Sync Config from Firebase for this specific user
    let userConfig = { isAIEnabled: true, groupEnabled: false, customReplies: {} };
    try {
        const res = await axios.get(`${firebaseConfig.databaseURL}/users/${userId}.json?auth=${firebaseConfig.apiKey}`);
        if(res.data) userConfig = res.data;
    } catch(e) {}

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Master-SaaS", "Chrome", "1.0.0"]
    });

    sessions[userId] = { sock, config: userConfig, bomberActive: false };

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (up) => {
        const { connection, qr } = up;
        if (qr) io.to(userId).emit('qr', await QRCode.toDataURL(qr));
        if (connection === 'open') io.to(userId).emit('connected', userConfig);
        if (connection === 'close') {
            if (up.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) startSession(userId);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe || !sessions[userId].config.isAIEnabled) return;
        
        const sender = m.key.remoteJid;
        const cleanNum = sender.replace(/[^0-9]/g, '');
        const msgText = m.message.conversation || m.message.extendedTextMessage?.text || "";

        if (sender.endsWith('@g.us') && !sessions[userId].config.groupEnabled) return;

        // Priority Logic
        if (sessions[userId].config.customReplies[cleanNum]) {
            await delay(1000);
            return await sock.sendMessage(sender, { text: sessions[userId].config.customReplies[cleanNum] }, { quoted: m });
        }

        // TXT Brain Reply
        const reply = await getSmartReply(userId, msgText);
        await delay(1500);
        await sock.sendMessage(sender, { text: reply }, { quoted: m });
    });
}

// --- 4. APIs ---
app.get('/dashboard/:userId', (req, res) => res.sendFile(__dirname + '/public/index.html'));

app.post('/api/save-config/:userId', async (req, res) => {
    const userId = req.params.userId;
    sessions[userId].config = req.body;
    await axios.put(`${firebaseConfig.databaseURL}/users/${userId}.json?auth=${firebaseConfig.apiKey}`, req.body);
    res.json({ success: true });
});

app.post('/api/upload-txt/:userId', upload.single('file'), async (req, res) => {
    const userId = req.params.userId;
    await fs.ensureDir(`./data/${userId}`);
    await fs.move(req.file.path, `./data/${userId}/smart-reply.txt`, { overwrite: true });
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
    let ms = { 'sec': 1, 'min': 60, 'hour': 3600, 'day': 86400 }[unit] * time * 1000;
    setTimeout(() => { 
        if(sessions[userId]) sessions[userId].sock.sendMessage(number + "@s.whatsapp.net", { text: message }); 
    }, ms);
    res.json({ success: true });
});

io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        socket.join(userId);
        if (!sessions[userId]) startSession(userId);
        else if (sessions[userId].sock.user) socket.emit('connected', sessions[userId].config);
    });
});

server.listen(process.env.PORT || 3000);
