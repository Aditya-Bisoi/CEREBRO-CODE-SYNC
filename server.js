// =============================================
// CEREBRO // CODE RED — WebSocket Sync Server
// =============================================
// Run with: node server.js
// Requires: npm install ws
// =============================================

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── ngrok public tunnel (optional) ──────────────────────────────
// Run: npm install @ngrok/ngrok
// Then set NGROK_TOKEN env var OR paste your token below
const NGROK_TOKEN = process.env.NGROK_TOKEN || '';  // ← paste token here
let publicUrl  = null;
let publicWsUrl = null;

// MIME types
const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
};

// HTTP server — login-gated, serves all static assets
const httpServer = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // Root → redirect to login
  if (urlPath === '/') {
    res.writeHead(302, { Location: '/login.html' });
    res.end(); return;
  }

  const ext      = path.extname(urlPath).toLowerCase();
  const mimeType = MIME[ext] || 'text/plain';
  const filePath = path.join(__dirname, urlPath);

  // Block directory traversal
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

// WebSocket server
const wss = new WebSocket.Server({ server: httpServer });

// Rooms: { roomCode: [ { ws, callsign, role } ] }
const rooms = {};

// Room security config: { roomCode: { password, maxListeners } }
const roomConfig = {};

// Default limits (broadcaster sets these when creating a room)
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

function getListenerCount(roomCode) {
  return getRoomClients(roomCode).filter(c => c.role === 'listener').length;
}

function getRoomClients(roomCode) {
  return rooms[roomCode] || [];
}

function addToRoom(roomCode, clientInfo) {
  if (!rooms[roomCode]) rooms[roomCode] = [];
  rooms[roomCode].push(clientInfo);
}

function removeFromRoom(ws) {
  for (const roomCode in rooms) {
    const idx = rooms[roomCode].findIndex(c => c.ws === ws);
    if (idx !== -1) {
      const client = rooms[roomCode][idx];
      rooms[roomCode].splice(idx, 1);
      if (rooms[roomCode].length === 0) delete rooms[roomCode];
      return { roomCode, client };
    }
  }
  return null;
}

function broadcastToRoom(roomCode, message, excludeWs = null) {
  const clients = getRoomClients(roomCode);
  const data = JSON.stringify(message);
  clients.forEach(c => {
    if (c.ws !== excludeWs && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(data);
    }
  });
}

function sendToClient(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function getRoomInfo(roomCode) {
  const clients = getRoomClients(roomCode);
  return clients.map(c => ({ callsign: c.callsign, role: c.role }));
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
    try {
      msg = JSON.parse(rawData);
    } catch (e) {
      console.error('[ERROR] Invalid JSON:', rawData);
      return;
    }

    switch (msg.type) {

      // Client joins a room
      case 'JOIN': {
        const { roomCode, callsign, role, password, maxListeners } = msg;

        // ── Broadcaster creates / configures the room ──
        if (role === 'broadcaster') {
          setRoomConfig(roomCode, password, maxListeners);
          console.log(`[CONFIG] Room "${roomCode}" | password: ${password ? '***SET***' : 'NONE'} | maxListeners: ${maxListeners || DEFAULT_MAX_LISTENERS}`);
        }

        const config = getRoomConfig(roomCode);

        // ── Security Check 1: Password ──
        if (config.password && role === 'listener') {
          if (!password || password !== config.password) {
            console.log(`[REJECT] ${callsign} — wrong password for room "${roomCode}"`);
            sendToClient(ws, {
              type: 'JOIN_REJECTED',
              reason: 'WRONG_PASSWORD',
              message: 'Incorrect room password'
            });
            ws.close();
            return;
          }
        }

        // ── Security Check 2: Max listener limit ──
        if (role === 'listener') {
          const listenerCount = getListenerCount(roomCode);
          if (listenerCount >= config.maxListeners) {
            console.log(`[REJECT] ${callsign} — room "${roomCode}" is full (${listenerCount}/${config.maxListeners})`);
            sendToClient(ws, {
              type: 'JOIN_REJECTED',
              reason: 'ROOM_FULL',
              message: `Room is full (${listenerCount}/${config.maxListeners} listeners)`
            });
            ws.close();
            return;
          }
        }

        // ── All checks passed — admit the client ──
        clientInfo = { ws, callsign, role, roomCode };
        addToRoom(roomCode, clientInfo);

        console.log(`[JOIN] ${callsign} (${role}) → room "${roomCode}" | ${getRoomClients(roomCode).length} clients | listeners: ${getListenerCount(roomCode)}/${config.maxListeners}`);

        // Confirm join to the client
        sendToClient(ws, {
          type: 'JOINED',
          roomCode,
          callsign,
          role,
          maxListeners: config.maxListeners,
          listenerCount: getListenerCount(roomCode),
          peers: getRoomInfo(roomCode).filter(p => p.callsign !== callsign)
        });

        // Notify others in the room
        broadcastToRoom(roomCode, {
          type: 'PEER_JOINED',
          callsign,
          role,
          listenerCount: getListenerCount(roomCode),
          maxListeners: config.maxListeners,
          peers: getRoomInfo(roomCode)
        }, ws);

        break;
      }

     case 'PLAY':
case 'PAUSE':
case 'SEEK':
case 'YT_PLAY':
case 'YT_PAUSE': {
  if (!clientInfo || clientInfo.role !== 'broadcaster') {
    console.log(`[REJECTED] ${clientInfo?.callsign} tried to control playback as a listener.`);
    break; // Exit without broadcasting to the room
  }
  
  broadcastToRoom(clientInfo.roomCode, {
    ...msg,
    callsign: clientInfo.callsign,
    serverTime: Date.now()
  }, ws);
  break;
}
      // Ping for latency measurement
      case 'PING': {
        sendToClient(ws, {
          type: 'PONG',
          clientTimestamp: msg.timestamp,
          serverTime: Date.now()
        });
        // Also relay ping to room for sync metrics
        if (clientInfo) {
          broadcastToRoom(clientInfo.roomCode, {
            ...msg,
            callsign: clientInfo.callsign,
            serverTime: Date.now()
          }, ws);
        }
        break;
      }

      // Chat / system message
      case 'MESSAGE': {
        if (!clientInfo) break;
        broadcastToRoom(clientInfo.roomCode, {
          type: 'MESSAGE',
          callsign: clientInfo.callsign,
          text: msg.text,
          serverTime: Date.now()
        }, ws);
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
      console.log(`[-] ${client.callsign} left room "${roomCode}" | ${getRoomClients(roomCode)?.length || 0} remaining`);
      broadcastToRoom(roomCode, {
        type: 'PEER_LEFT',
        callsign: client.callsign,
        peers: getRoomInfo(roomCode)
      });
    }
  });

  ws.on('error', (err) => {
    console.error(`[ERROR] WebSocket error: ${err.message}`);
  });
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
      if (net.family === 'IPv4' && !net.internal) {
        localIP = net.address; break;
      }
    }
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   CEREBRO // CODE RED SYNC SERVER        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${localIP}:${PORT}`);
  console.log(`\n  [WiFi] Share with same-network devices:`);
  console.log(`  → http://${localIP}:${PORT}`);
  console.log(`  → ws://${localIP}:${PORT}  (Server URL field)\n`);

  // ── Try to start ngrok tunnel ──────────────────────────────────
  if (NGROK_TOKEN) {
    try {
      const ngrok = require('@ngrok/ngrok');
      const listener = await ngrok.forward({
        addr: PORT,
        authtoken: NGROK_TOKEN,
      });
      publicUrl   = listener.url();
      publicWsUrl = publicUrl.replace('https://', 'wss://').replace('http://', 'ws://');

      console.log('  ╔════════════════════════════════════════╗');
      console.log('  ║  🌐 NGROK TUNNEL ACTIVE — ANY NETWORK  ║');
      console.log('  ╚════════════════════════════════════════╝');
      console.log(`  → Open:       ${publicUrl}`);
      console.log(`  → Server URL: ${publicWsUrl}`);
      console.log('  (Share these with listeners on ANY WiFi/4G)\n');
    } catch (e) {
      console.log('  [ngrok] Not available:', e.message);
      console.log('  [ngrok] Run: npm install @ngrok/ngrok\n');
    }
  } else {
    console.log('  [ngrok] Token not set — local network only.');
    console.log('  To enable public access:');
    console.log('  1. Get free token at https://ngrok.com');
    console.log('  2. Paste it in server.js: NGROK_TOKEN = \'your-token\'');
    console.log('  3. Run: npm install @ngrok/ngrok\n');
  }

  console.log('  Waiting for connections...\n');
});