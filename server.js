const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}_${uuid()}.jpg`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// In-memory database
const db = { devices: {}, locations: {}, alerts: {}, photos: {}, commands: {} };

function ensure(token) {
    if (!db.locations[token]) db.locations[token] = [];
    if (!db.alerts[token])    db.alerts[token]    = [];
    if (!db.photos[token])    db.photos[token]    = [];
    if (!db.commands[token])  db.commands[token]  = [];
}

// ── Health check — works at both /health and /api/health ──
app.get(['/health', '/api/health'], (req, res) => {
    res.json({ status: 'running', version: '1.0.0', devices: Object.keys(db.devices).length, uptime: process.uptime() });
});

// ── Root ──
app.get(['/', '/api'], (req, res) => {
    res.json({ name: 'PhoneGuard Server', version: '1.0.0', devices: Object.keys(db.devices).length, status: 'running' });
});

// ── Register ──
app.post(['/register', '/api/register'], (req, res) => {
    const { token, nickname, imei, model, platform } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    ensure(token);
    db.devices[token] = {
        token, nickname: nickname || 'My Phone', imei: imei || 'unknown',
        model: model || 'Android', platform: platform || 'android',
        registeredAt: db.devices[token]?.registeredAt || new Date().toISOString(),
        lastSeen: new Date().toISOString(), battery: 100, status: 'registered',
        pingCount: db.devices[token]?.pingCount || 0,
        photoCount: db.devices[token]?.photoCount || 0,
        alertCount: db.devices[token]?.alertCount || 0,
        lastLat: 0, lastLng: 0,
    };
    res.json({ success: true, token });
});

// ── Location ping ──
app.post(['/ping', '/api/ping'], (req, res) => {
    const { token, lat, lng, accuracy, battery, speed, source, ts } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    ensure(token);
    const ping = {
        id: uuid(), lat: parseFloat(lat) || 0, lng: parseFloat(lng) || 0,
        accuracy: parseFloat(accuracy) || 0, battery: parseInt(battery) || 0,
        speed: parseFloat(speed) || 0, source: source || 'gps',
        ts: ts || Date.now(), receivedAt: new Date().toISOString()
    };
    db.locations[token].unshift(ping);
    if (db.locations[token].length > 1000) db.locations[token].pop();
    if (!db.devices[token]) {
        db.devices[token] = { token, nickname: 'My Phone', imei: 'unknown', model: 'Android', platform: 'android', registeredAt: new Date().toISOString(), pingCount: 0, photoCount: 0, alertCount: 0 };
    }
    db.devices[token].lastSeen  = new Date().toISOString();
    db.devices[token].battery   = ping.battery;
    db.devices[token].lastLat   = ping.lat;
    db.devices[token].lastLng   = ping.lng;
    db.devices[token].status    = 'tracking';
    db.devices[token].pingCount = (db.devices[token].pingCount || 0) + 1;
    res.json({ success: true, pingCount: db.devices[token].pingCount });
});

// ── Alert ──
app.post(['/alert', '/api/alert'], (req, res) => {
    const { token, type, new_sim, new_number, lat, lng, ts } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    ensure(token);
    const alert = {
        id: uuid(), type: type || 'unknown', new_sim: new_sim || '',
        new_number: new_number || '', lat: parseFloat(lat) || 0,
        lng: parseFloat(lng) || 0, ts: ts || Date.now(), receivedAt: new Date().toISOString()
    };
    db.alerts[token].unshift(alert);
    if (db.alerts[token].length > 200) db.alerts[token].pop();
    if (db.devices[token]) {
        db.devices[token].alertCount = (db.devices[token].alertCount || 0) + 1;
        db.devices[token].lastSeen = new Date().toISOString();
    }
    res.json({ success: true });
});

// ── Photo ──
app.post(['/photo', '/api/photo'], upload.single('photo'), (req, res) => {
    const { token, trigger, lat, lng } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    ensure(token);
    const record = {
        id: uuid(), trigger: trigger || 'unknown',
        lat: parseFloat(lat) || 0, lng: parseFloat(lng) || 0,
        ts: Date.now(), receivedAt: new Date().toISOString(),
        filename: req.file?.filename || null,
        url: req.file ? `/uploads/${req.file.filename}` : null
    };
    db.photos[token].unshift(record);
    if (db.photos[token].length > 100) db.photos[token].pop();
    if (db.devices[token]) db.devices[token].photoCount = (db.devices[token].photoCount || 0) + 1;
    res.json({ success: true, photo: record });
});

// ── Commands ──
app.get(['/commands', '/api/commands'], (req, res) => {
    const token = req.query.token;
    if (!token) return res.json([]);
    ensure(token);
    const pending = db.commands[token] || [];
    db.commands[token] = [];
    if (db.devices[token]) db.devices[token].lastSeen = new Date().toISOString();
    res.json(pending);
});

app.post(['/command', '/api/command'], (req, res) => {
    const { token, command } = req.body;
    if (!token || !command) return res.status(400).json({ error: 'Token and command required' });
    ensure(token);
    const cmd = { id: uuid(), command: command.toLowerCase(), sentAt: new Date().toISOString(), status: 'pending' };
    db.commands[token].push(cmd);
    res.json({ success: true, command: cmd });
});

app.post(['/ack', '/api/ack'], (req, res) => res.json({ success: true }));

// ── Device data ──
app.get(['/devices', '/api/devices'], (req, res) => res.json(Object.values(db.devices)));

app.get(['/device/:token', '/api/device/:token'], (req, res) => {
    const { token } = req.params;
    if (!db.devices[token]) return res.status(404).json({ error: 'Not found' });
    res.json({
        device: db.devices[token],
        lastLocation: db.locations[token]?.[0] || null,
        alertCount: db.alerts[token]?.length || 0,
        photoCount: db.photos[token]?.length || 0,
    });
});

app.get(['/locations/:token', '/api/locations/:token'], (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json((db.locations[req.params.token] || []).slice(0, limit));
});

app.get(['/alerts/:token', '/api/alerts/:token'], (req, res) => res.json(db.alerts[req.params.token] || []));
app.get(['/photos/:token', '/api/photos/:token'], (req, res) => res.json(db.photos[req.params.token] || []));

app.listen(PORT, () => console.log(`PhoneGuard Server running on port ${PORT}`));
