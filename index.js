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

// --- CONFIGURATION ---
const MY_URL = "https://your-app-name.onrender.com"; 
const firebaseConfig = {
    apiKey: "AIzaSyAb7V8Xxg5rUYi8UKChEd3rR5dglJ6bLhU",
    databaseURL: "https://t2-storage-4e5ca-default-rtdb.firebaseio.com",
};

let sessions = {}; 

// 1. Render Anti-Sleep (Har 4 min mein self-ping)
setInterval(() => { axios.get(MY_URL).catch(() => {}); }, 4 * 60 * 1000);

// 2. Advanced AI Parser (Linux Style)
async function getAIBrainReply(userId, userMsg) {
    const path = `./data/${userId}/chat.txt`;
    if (!await fs.pathExists(path)) return "Ji, abhi busy hoon. 😊";

    const content = await fs.readFile(path, 'utf8');
    const lines = content.split('\n');
    let chatMemory = [];
    let lastStrangerMsg = "";

    lines.forEach(line => {
        const match = line.match(/\] (.*?): (.*)/);
        if (match) {
            let name = match[1].trim();
            let msg = match[2].trim();
            // Agar "Linux" naam hai toh wo AI ka reply hai
            if (name.includes("Linux")) {
                if (lastStrangerMsg) chatMemory.push({ input: lastStrangerMsg.toLowerCase(), output: msg });
            } else {
                lastStrangerMsg = msg;
            }
        }
    });

    const cleanInput = userMsg.toLowerCase().trim();
    const match = chatMemory.find(c => cleanInput.includes(c.input) || c.input.includes(cleanInput));
    return match ? match.output : "Theek hai, note kar liya. 👍";
}

// 3. Multi-Instance Handler
async function startInstance(userId) {
    const sessionPath = `./sessions/${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    let config = { isAIEnabled: true, groupEnabled: false, customReplies: {} };
    try {
        const res = await axios.get(`${firebaseConfig.databaseURL}/users/${userId}.json?auth=${firebaseConfig.apiKey}`);
        if(res.data) config = res.data;
    } catch(e) {}

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["SaaS-Bot", "Chrome", "1.0.0"]
    });

    sessions[userId] = { sock, config, bomberActive: false };

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (up) => {
        const { connection, qr } = up;
        if (qr) io.to(userId).emit('qr', await QRCode.toDataURL(qr));
        if (connection === 'open') io.to(userId).emit('ready', config);
        if (connection === 'close' && up.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
            startInstance(userId);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;
        
        const sender = m.key.remoteJid;
        const msgText = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const cleanNum = sender.replace(/[^0-9]/g, '');

        if (sender.endsWith('@g.us') && !sessions[userId].config.groupEnabled) return;

        // Priority Custom Reply
        if (sessions[userId].config.customReplies[cleanNum]) {
            return await sock.sendMessage(sender, { text: sessions[userId].config.customReplies[cleanNum] });
        }

        // AI Training Reply
        if (sessions[userId].config.isAIEnabled) {
            const reply = await getAIBrainReply(userId, msgText);
            await delay(2000);
            await sock.sendMessage(sender, { text: reply }, { quoted: m });
        }
    });
}

// 4. APIs
app.get('/dashboard/:userId', (req, res) => res.sendFile(__dirname + '/public/dashboard.html'));

app.post('/api/upload/:userId', upload.single('file'), async (req, res) => {
    const userId = req.params.userId;
    await fs.ensureDir(`./data/${userId}`);
    await fs.move(req.file.path, `./data/${userId}/chat.txt`, { overwrite: true });
    res.json({ success: true });
});

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

server.listen(process.env.PORT || 3000);
