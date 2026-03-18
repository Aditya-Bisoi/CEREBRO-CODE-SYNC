// =============================================
// CEREBRO // CODE RED — WebSocket Sync Server
// =============================================
// Run locally:  node server.js
// Run on Render: auto-starts via npm start
// Production:   https://cerebro-code-sync.onrender.com
//               wss://cerebro-code-sync.onrender.com
// =============================================

const WebSocket = require('ws');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');

const PORT = process.env.PORT || 3000;

// ── Deployment URL (Render) ──────────────────────────────────────
const RENDER_URL    = 'https://cerebro-code-sync.onrender.com';
const RENDER_WS_URL = 'wss://cerebro-code-sync.onrender.com';

// ── ngrok public tunnel (for local → internet access) ────────────
// HOW TO USE:
//   1. Sign up free at https://ngrok.com
//   2. Get your authtoken: https://dashboard.ngrok.com/get-started/your-authtoken
//   3a. Set env var:  NGROK_TOKEN=your_token node server.js
//   3b. OR paste token directly below:
const NGROK_TOKEN = process.env.NGROK_TOKEN || '';  // ← paste token here

let publicUrl   = null;
let publicWsUrl = null;

// ── MIME types ───────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

// ── HTTP server ──────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  if (urlPath === '/') {
    res.writeHead(302, { Location: '/login.html' });
    res.end();
    return;
  }

  const ext      = path.extname(urlPath).toLowerCase();
  const mimeType = MIME[ext] || 'text/plain';
  const filePath = path.join(__dirname, urlPath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': mimeType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not found: ' + urlPath);
  }
});

// ── WebSocket server ─────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

const rooms      = {};
const roomConfig = {};
const DEFAULT_MAX_LISTENERS = 10;

function setRoomConfig(roomCode, password, maxListeners) {
  roomConfig[roomCode] = {
    password:     password || '',
    maxListeners: parseInt(maxListeners) || DEFAULT_MAX_LISTENERS,
  };
}
function getRoomConfig(roomCode) {
  return roomConfig[roomCode] || { password: '', maxListeners: DEFAULT_MAX_LISTENERS };
}
function getRoomClients(roomCode)  { return rooms[roomCode] || []; }
function getListenerCount(roomCode){ return getRoomClients(roomCode).filter(c => c.role === 'listener').length; }
function addToRoom(roomCode, info) { if (!rooms[roomCode]) rooms[roomCode] = []; rooms[roomCode].push(info); }
function removeFromRoom(ws) {
  for (const roomCode in rooms) {
    const idx = rooms[roomCode].findIndex(c => c.ws === ws);
    if (idx !== -1) {
      const client = rooms[roomCode].splice(idx, 1)[0];
      if (rooms[roomCode].length === 0) delete rooms[roomCode];
      return { roomCode, client };
    }
  }
  return null;
}
function broadcastToRoom(roomCode, message, excludeWs = null) {
  const data = JSON.stringify(message);
  getRoomClients(roomCode).forEach(c => {
    if (c.ws !== excludeWs && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  });
}
function sendToClient(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function getRoomInfo(roomCode) {
  return getRoomClients(roomCode).map(c => ({ callsign: c.callsign, role: c.role }));
}

// =============================================
// WebSocket connection handler
// =============================================
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[+] New connection from ${ip}`);
  let clientInfo = null;

  ws.on('message', (rawData) => {
    let msg;
    try { msg = JSON.parse(rawData); }
    catch (e) { console.error('[ERROR] Invalid JSON'); return; }

    switch (msg.type) {

      case 'JOIN': {
        const { roomCode, callsign, role, password, maxListeners } = msg;

        if (role === 'broadcaster') {
          setRoomConfig(roomCode, password, maxListeners);
          console.log(`[CONFIG] Room "${roomCode}" | pw: ${password ? 'SET' : 'NONE'} | maxListeners: ${maxListeners || DEFAULT_MAX_LISTENERS}`);
        }

        const config = getRoomConfig(roomCode);

        // Password check
        if (config.password && role === 'listener') {
          if (!password || password !== config.password) {
            console.log(`[REJECT] ${callsign} — wrong password for "${roomCode}"`);
            sendToClient(ws, { type: 'JOIN_REJECTED', reason: 'WRONG_PASSWORD', message: 'Incorrect room password' });
            ws.close(); return;
          }
        }

        // Listener limit check
        if (role === 'listener') {
          const count = getListenerCount(roomCode);
          if (count >= config.maxListeners) {
            console.log(`[REJECT] ${callsign} — room "${roomCode}" full (${count}/${config.maxListeners})`);
            sendToClient(ws, { type: 'JOIN_REJECTED', reason: 'ROOM_FULL', message: `Room is full (${count}/${config.maxListeners})` });
            ws.close(); return;
          }
        }

        clientInfo = { ws, callsign, role, roomCode };
        addToRoom(roomCode, clientInfo);
        console.log(`[JOIN] ${callsign} (${role}) → "${roomCode}" | ${getRoomClients(roomCode).length} total`);

        sendToClient(ws, {
          type: 'JOINED', roomCode, callsign, role,
          maxListeners: config.maxListeners,
          listenerCount: getListenerCount(roomCode),
          peers: getRoomInfo(roomCode).filter(p => p.callsign !== callsign)
        });
        broadcastToRoom(roomCode, {
          type: 'PEER_JOINED', callsign, role,
          listenerCount: getListenerCount(roomCode),
          maxListeners: config.maxListeners,
          peers: getRoomInfo(roomCode)
        }, ws);
        break;
      }

      // Broadcaster-only playback controls
      case 'PLAY':
      case 'PAUSE':
      case 'SEEK':
      case 'STOP':
      case 'YT_PLAY':
      case 'YT_PAUSE':
      case 'YT_SEEK':
      case 'YT_STOP':
      case 'YT_LOAD':
      case 'SOURCE_SWITCH': {
        if (!clientInfo || clientInfo.role !== 'broadcaster') {
          console.log(`[BLOCKED] ${clientInfo?.callsign} tried to send ${msg.type} as listener`);
          break;
        }
        broadcastToRoom(clientInfo.roomCode, { ...msg, callsign: clientInfo.callsign, serverTime: Date.now() }, ws);
        break;
      }

      case 'PING': {
        sendToClient(ws, { type: 'PONG', clientTimestamp: msg.timestamp, serverTime: Date.now() });
        if (clientInfo) broadcastToRoom(clientInfo.roomCode, { ...msg, callsign: clientInfo.callsign, serverTime: Date.now() }, ws);
        break;
      }

      case 'MESSAGE': {
        if (!clientInfo) break;
        broadcastToRoom(clientInfo.roomCode, { type: 'MESSAGE', callsign: clientInfo.callsign, text: msg.text, serverTime: Date.now() }, ws);
        break;
      }

      default:
        console.log(`[UNKNOWN] type=${msg.type}`);
    }
  });

  ws.on('close', () => {
    const result = removeFromRoom(ws);
    if (result) {
      const { roomCode, client } = result;
      console.log(`[-] ${client.callsign} left "${roomCode}" | ${getRoomClients(roomCode)?.length || 0} remaining`);
      broadcastToRoom(roomCode, { type: 'PEER_LEFT', callsign: client.callsign, peers: getRoomInfo(roomCode) });
    }
  });

  ws.on('error', (err) => console.error(`[ERROR] ${err.message}`));
});

// =============================================
// Start server
// =============================================
httpServer.listen(PORT, '0.0.0.0', async () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     CEREBRO // CODE RED — SYNC SERVER        ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\n  Local:      http://localhost:${PORT}`);
  console.log(`  Network:    http://${localIP}:${PORT}`);
  console.log(`  Production: ${RENDER_URL}`);
  console.log(`  WSS:        ${RENDER_WS_URL}\n`);

  // ── ngrok tunnel ──────────────────────────────────────────────
  if (NGROK_TOKEN) {
    try {
      const ngrok    = require('@ngrok/ngrok');
      const listener = await ngrok.forward({ addr: PORT, authtoken: NGROK_TOKEN });

      publicUrl   = listener.url();
      publicWsUrl = publicUrl.replace('https://', 'wss://').replace('http://', 'ws://');

      console.log('  ╔══════════════════════════════════════════╗');
      console.log('  ║   🌐  NGROK TUNNEL ACTIVE               ║');
      console.log('  ╚══════════════════════════════════════════╝');
      console.log(`  → Browser:  ${publicUrl}`);
      console.log(`  → WS URL:   ${publicWsUrl}`);
      console.log('  Share these with listeners on any network.\n');

    } catch (e) {
      console.log('  [ngrok] ❌ Failed to start:', e.message);
      console.log('  [ngrok] Run: npm install @ngrok/ngrok\n');
    }
  } else {
    console.log('  ── ngrok not active (local network only) ────');
    console.log('  To tunnel to internet:');
    console.log('  1. Free token → https://ngrok.com');
    console.log('  2. NGROK_TOKEN=your_token node server.js');
    console.log('     OR paste token in server.js line 21\n');
  }

  console.log('  Waiting for connections...\n');
});