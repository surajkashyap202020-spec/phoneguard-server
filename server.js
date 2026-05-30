/**
 * PhoneGuard Backend Server
 * 
 * Connects the Android app to the web dashboard.
 * Stores location pings, photos, alerts in memory (no database needed).
 * Real-time updates via WebSocket to the dashboard.
 * 
 * Endpoints:
 *   POST /api/register        - Register a new device
 *   POST /api/ping            - Receive location ping from Android app
 *   POST /api/alert           - Receive SIM change / shutdown alert
 *   POST /api/photo           - Receive evidence photo from Android app
 *   POST /api/ack             - Receive command acknowledgement
 *   GET  /api/commands        - Android app polls for pending commands
 *   POST /api/command         - Dashboard sends command to device
 *   GET  /api/devices         - Dashboard fetches all devices
 *   GET  /api/device/:token   - Dashboard fetches one device's data
 *   GET  /api/locations/:token - Dashboard fetches location history
 *   GET  /api/alerts/:token   - Dashboard fetches alerts
 *   GET  /health              - Health check for Render
 */

const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const { v4: uuid } = require('uuid');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const fs         = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded photos
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/photos', express.static(uploadDir));

// Photo upload config
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => cb(null, `${Date.now()}_${uuid()}.jpg`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── In-memory database ────────────────────────────────────
// In production you'd use a real DB. For now, memory is fine.
const db = {
    devices:   {},   // token -> device info
    locations: {},   // token -> [ ...location pings ]
    alerts:    {},   // token -> [ ...alerts ]
    photos:    {},   // token -> [ ...photo records ]
    commands:  {},   // token -> [ ...pending commands ]
};

// ── WebSocket broadcast to dashboard ─────────────────────
function broadcast(token, type, data) {
    const msg = JSON.stringify({ token, type, data, ts: Date.now() });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// ── Helper: ensure arrays exist for token ────────────────
function ensure(token) {
    if (!db.locations[token]) db.locations[token] = [];
    if (!db.alerts[token])    db.alerts[token]    = [];
    if (!db.photos[token])    db.photos[token]    = [];
    if (!db.commands[token])  db.commands[token]  = [];
}

// ══════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════

// Health check (Render needs this)
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/',       (req, res) => res.json({ 
    name: 'PhoneGuard Server', 
    version: '1.0.0',
    devices: Object.keys(db.devices).length,
    status: 'running'
}));

// ── Register device ───────────────────────────────────────
app.post('/api/register', (req, res) => {
    const { token, nickname, imei, model, platform } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    ensure(token);
    db.devices[token] = {
        token,
        nickname:     nickname || 'Unknown Device',
        imei:         imei     || 'unknown',
        model:        model    || 'Android',
        platform:     platform || 'android',
        registeredAt: db.devices[token]?.registeredAt || new Date().toISOString(),
        lastSeen:     new Date().toISOString(),
        battery:      100,
        status:       'active',
        pingCount:    db.devices[token]?.pingCount || 0,
        photoCount:   db.devices[token]?.photoCount || 0,
        lastLat:      0,
        lastLng:      0,
    };

    console.log(`📱 Device registered: ${nickname} (${token})`);
    broadcast(token, 'device_registered', db.devices[token]);
    res.json({ success: true, message: 'Device registered', token });
});

// ── Location ping ─────────────────────────────────────────
app.post('/api/ping', (req, res) => {
    const { token, lat, lng, accuracy, battery, speed, source, ts } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    ensure(token);

    const ping = {
        id:       uuid(),
        lat:      parseFloat(lat)      || 0,
        lng:      parseFloat(lng)      || 0,
        accuracy: parseFloat(accuracy) || 0,
        battery:  parseInt(battery)    || 0,
        speed:    parseFloat(speed)    || 0,
        source:   source || 'gps',
        ts:       ts || Date.now(),
        receivedAt: new Date().toISOString()
    };

    // Keep last 500 pings per device
    db.locations[token].unshift(ping);
    if (db.locations[token].length > 500) db.locations[token].pop();

    // Update device status
    if (db.devices[token]) {
        db.devices[token].lastSeen  = new Date().toISOString();
        db.devices[token].battery   = ping.battery;
        db.devices[token].lastLat   = ping.lat;
        db.devices[token].lastLng   = ping.lng;
        db.devices[token].status    = 'tracking';
        db.devices[token].pingCount = (db.devices[token].pingCount || 0) + 1;
    }

    console.log(`📍 Ping from ${token}: ${ping.lat}, ${ping.lng} (${ping.source})`);
    broadcast(token, 'location', ping);
    res.json({ success: true });
});

// ── Alert (SIM change, shutdown, etc.) ───────────────────
app.post('/api/alert', (req, res) => {
    const { token, type, new_sim, new_number, lat, lng, ts } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    ensure(token);

    const alert = {
        id:         uuid(),
        type:       type || 'unknown',
        new_sim:    new_sim || '',
        new_number: new_number || '',
        lat:        parseFloat(lat) || 0,
        lng:        parseFloat(lng) || 0,
        ts:         ts || Date.now(),
        receivedAt: new Date().toISOString()
    };

    db.alerts[token].unshift(alert);
    if (db.alerts[token].length > 100) db.alerts[token].pop();

    if (db.devices[token]) {
        db.devices[token].lastSeen = new Date().toISOString();
        db.devices[token].alertCount = (db.devices[token].alertCount || 0) + 1;
    }

    console.log(`🚨 Alert from ${token}: ${type}`);
    broadcast(token, 'alert', alert);
    res.json({ success: true });
});

// ── Photo upload ──────────────────────────────────────────
app.post('/api/photo', upload.single('photo'), (req, res) => {
    const { token, trigger, lat, lng, ts } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    ensure(token);

    const photoRecord = {
        id:         uuid(),
        trigger:    trigger || 'unknown',
        lat:        parseFloat(lat) || 0,
        lng:        parseFloat(lng) || 0,
        ts:         ts || Date.now(),
        receivedAt: new Date().toISOString(),
        filename:   req.file ? req.file.filename : null,
        url:        req.file ? `/photos/${req.file.filename}` : null
    };

    db.photos[token].unshift(photoRecord);
    if (db.photos[token].length > 50) db.photos[token].pop();

    if (db.devices[token]) {
        db.devices[token].photoCount = (db.devices[token].photoCount || 0) + 1;
    }

    console.log(`📸 Photo from ${token}: ${trigger}`);
    broadcast(token, 'photo', photoRecord);
    res.json({ success: true, photo: photoRecord });
});

// ── Poll commands (Android app calls this every 60s) ──────
app.get('/api/commands', (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Token required' });

    ensure(token);

    // Return pending commands and clear them
    const pending = db.commands[token] || [];
    db.commands[token] = [];

    if (db.devices[token]) {
        db.devices[token].lastSeen = new Date().toISOString();
    }

    res.json(pending);
});

// ── Send command from dashboard ───────────────────────────
app.post('/api/command', (req, res) => {
    const { token, command } = req.body;
    if (!token || !command) return res.status(400).json({ error: 'Token and command required' });

    ensure(token);

    const cmd = {
        id:        uuid(),
        command:   command.toLowerCase(),
        sentAt:    new Date().toISOString(),
        status:    'pending'
    };

    db.commands[token].push(cmd);

    console.log(`📡 Command sent to ${token}: ${command}`);
    broadcast(token, 'command_sent', cmd);
    res.json({ success: true, command: cmd });
});

// ── Command ack from device ───────────────────────────────
app.post('/api/ack', (req, res) => {
    const { token, command_id, status } = req.body;
    broadcast(token, 'command_ack', { command_id, status });
    res.json({ success: true });
});

// ── Get all devices (dashboard) ───────────────────────────
app.get('/api/devices', (req, res) => {
    res.json(Object.values(db.devices));
});

// ── Get one device detail ─────────────────────────────────
app.get('/api/device/:token', (req, res) => {
    const { token } = req.params;
    const device = db.devices[token];
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json({
        device,
        lastLocation: db.locations[token]?.[0] || null,
        alertCount:   db.alerts[token]?.length  || 0,
        photoCount:   db.photos[token]?.length  || 0,
    });
});

// ── Location history ──────────────────────────────────────
app.get('/api/locations/:token', (req, res) => {
    const { token } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    res.json((db.locations[token] || []).slice(0, limit));
});

// ── Alerts history ────────────────────────────────────────
app.get('/api/alerts/:token', (req, res) => {
    const { token } = req.params;
    res.json(db.alerts[token] || []);
});

// ── Photos list ───────────────────────────────────────────
app.get('/api/photos/:token', (req, res) => {
    const { token } = req.params;
    res.json(db.photos[token] || []);
});

// ── WebSocket connection ──────────────────────────────────
wss.on('connection', (ws) => {
    console.log('🖥️  Dashboard connected via WebSocket');
    ws.send(JSON.stringify({ type: 'connected', message: 'PhoneGuard server ready' }));
    ws.on('close', () => console.log('🖥️  Dashboard disconnected'));
});

// ── Start server ──────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`\n🛡️  PhoneGuard Server running on port ${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api`);
    console.log(`🌐 Health: http://localhost:${PORT}/health\n`);
});
