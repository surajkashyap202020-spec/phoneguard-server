const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const { v4: uuid } = require('uuid');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Storage paths ─────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, 'data');
const UPLOAD_DIR  = path.join(__dirname, 'uploads');
[DATA_DIR, UPLOAD_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_DIR),
        filename:    (req, file, cb) => cb(null, `${Date.now()}_${uuid()}.jpg`)
    }),
    limits: { fileSize: 10 * 1024 * 1024 }
});

// ── File-based storage helpers ────────────────────────────
function readJson(file) {
    try {
        const f = path.join(DATA_DIR, file);
        if (!fs.existsSync(f)) return {};
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch(e) { return {}; }
}

function writeJson(file, data) {
    try { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data), 'utf8'); }
    catch(e) { console.error('Write error:', e.message); }
}

function readArr(file) {
    try {
        const f = path.join(DATA_DIR, file);
        if (!fs.existsSync(f)) return [];
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch(e) { return []; }
}

function writeArr(file, data) {
    try { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data), 'utf8'); }
    catch(e) {}
}

// ── Routes ────────────────────────────────────────────────
// Health — both with and without /api prefix
app.get(['/health', '/api/health'], (req, res) => {
    const devices = readJson('devices.json');
    res.json({ status: 'running', version: '2.0', devices: Object.keys(devices).length, uptime: process.uptime() });
});

app.get(['/', '/api'], (req, res) => {
    const devices = readJson('devices.json');
    res.json({ name: 'PhoneGuard Server', version: '2.0', devices: Object.keys(devices).length, status: 'running' });
});

// Register
app.post(['/register', '/api/register'], (req, res) => {
    const { token, nickname, imei, model, platform } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const devices = readJson('devices.json');
    devices[token] = {
        token, nickname: nickname || 'My Phone',
        imei: imei || 'unknown', model: model || 'Android', platform: platform || 'android',
        registeredAt: devices[token]?.registeredAt || new Date().toISOString(),
        lastSeen: new Date().toISOString(), battery: devices[token]?.battery || 100,
        status: 'registered',
        pingCount:  devices[token]?.pingCount  || 0,
        photoCount: devices[token]?.photoCount || 0,
        alertCount: devices[token]?.alertCount || 0,
        lastLat: devices[token]?.lastLat || 0,
        lastLng: devices[token]?.lastLng || 0,
    };
    writeJson('devices.json', devices);
    res.json({ success: true, token });
});

// Ping — location update
app.post(['/ping', '/api/ping'], (req, res) => {
    const { token, lat, lng, accuracy, battery, speed, source, ts } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const ping = {
        id: uuid(),
        lat:      parseFloat(lat)      || 0,
        lng:      parseFloat(lng)      || 0,
        accuracy: parseFloat(accuracy) || 0,
        battery:  parseInt(battery)    || 0,
        speed:    parseFloat(speed)    || 0,
        source:   source || 'gps',
        ts:       ts || Date.now(),
        receivedAt: new Date().toISOString()
    };

    // Save location
    const locFile = `loc_${token}.json`;
    const locs = readArr(locFile);
    locs.unshift(ping);
    if (locs.length > 1000) locs.length = 1000;
    writeArr(locFile, locs);

    // Update device
    const devices = readJson('devices.json');
    if (!devices[token]) {
        devices[token] = { token, nickname: 'My Phone', imei: 'unknown', model: 'Android', platform: 'android', registeredAt: new Date().toISOString(), pingCount: 0, photoCount: 0, alertCount: 0 };
    }
    devices[token].lastSeen  = new Date().toISOString();
    devices[token].battery   = ping.battery;
    devices[token].lastLat   = ping.lat;
    devices[token].lastLng   = ping.lng;
    devices[token].status    = 'tracking';
    devices[token].pingCount = (devices[token].pingCount || 0) + 1;
    writeJson('devices.json', devices);

    res.json({ success: true, pingCount: devices[token].pingCount });
});

// Alert
app.post(['/alert', '/api/alert'], (req, res) => {
    const { token, type, new_sim, new_number, lat, lng, ts } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const alert = {
        id: uuid(), type: type || 'unknown',
        new_sim: new_sim || '', new_number: new_number || '',
        lat: parseFloat(lat) || 0, lng: parseFloat(lng) || 0,
        ts: ts || Date.now(), receivedAt: new Date().toISOString()
    };
    const alertFile = `alerts_${token}.json`;
    const alerts = readArr(alertFile);
    alerts.unshift(alert);
    if (alerts.length > 200) alerts.length = 200;
    writeArr(alertFile, alerts);

    const devices = readJson('devices.json');
    if (devices[token]) {
        devices[token].alertCount = (devices[token].alertCount || 0) + 1;
        devices[token].lastSeen = new Date().toISOString();
        writeJson('devices.json', devices);
    }
    res.json({ success: true });
});

// Photo upload
app.post(['/photo', '/api/photo'], upload.single('photo'), (req, res) => {
    const { token, trigger, lat, lng } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const record = {
        id: uuid(), trigger: trigger || 'unknown',
        lat: parseFloat(lat) || 0, lng: parseFloat(lng) || 0,
        ts: Date.now(), receivedAt: new Date().toISOString(),
        filename: req.file?.filename || null,
        url: req.file ? `/uploads/${req.file.filename}` : null
    };
    const photoFile = `photos_${token}.json`;
    const photos = readArr(photoFile);
    photos.unshift(record);
    if (photos.length > 100) photos.length = 100;
    writeArr(photoFile, photos);

    const devices = readJson('devices.json');
    if (devices[token]) {
        devices[token].photoCount = (devices[token].photoCount || 0) + 1;
        writeJson('devices.json', devices);
    }
    res.json({ success: true, photo: record });
});

// Commands
app.get(['/commands', '/api/commands'], (req, res) => {
    const token = req.query.token;
    if (!token) return res.json([]);
    const cmdFile = `cmds_${token}.json`;
    const cmds = readArr(cmdFile);
    writeArr(cmdFile, []); // clear after reading
    const devices = readJson('devices.json');
    if (devices[token]) { devices[token].lastSeen = new Date().toISOString(); writeJson('devices.json', devices); }
    res.json(cmds);
});

app.post(['/command', '/api/command'], (req, res) => {
    const { token, command } = req.body;
    if (!token || !command) return res.status(400).json({ error: 'Token and command required' });
    const cmd = { id: uuid(), command: command.toLowerCase(), sentAt: new Date().toISOString(), status: 'pending' };
    const cmdFile = `cmds_${token}.json`;
    const cmds = readArr(cmdFile);
    cmds.push(cmd);
    writeArr(cmdFile, cmds);
    res.json({ success: true, command: cmd });
});

app.post(['/ack', '/api/ack'], (req, res) => res.json({ success: true }));

// Device data
app.get(['/devices', '/api/devices'], (req, res) => {
    res.json(Object.values(readJson('devices.json')));
});

app.get(['/device/:token', '/api/device/:token'], (req, res) => {
    const { token } = req.params;
    const devices = readJson('devices.json');
    if (!devices[token]) return res.status(404).json({ error: 'Not found' });
    const locs = readArr(`loc_${token}.json`);
    res.json({
        device: devices[token],
        lastLocation: locs[0] || null,
        alertCount: readArr(`alerts_${token}.json`).length,
        photoCount: readArr(`photos_${token}.json`).length,
    });
});

app.get(['/locations/:token', '/api/locations/:token'], (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json(readArr(`loc_${req.params.token}.json`).slice(0, limit));
});

app.get(['/alerts/:token', '/api/alerts/:token'], (req, res) => {
    res.json(readArr(`alerts_${req.params.token}.json`));
});

app.get(['/photos/:token', '/api/photos/:token'], (req, res) => {
    res.json(readArr(`photos_${req.params.token}.json`));
});

app.listen(PORT, () => console.log(`PhoneGuard Server v2.0 running on port ${PORT}`));
