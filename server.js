// =============================================
// CEREBRO // CODE RED — WebSocket Sync Server
// =============================================
// Run with: node server.js
// Requires: npm install ws
// =============================================

// =============================================
// CEREBRO // CODE RED — WebSocket Sync Server
// =============================================
// =============================================
// CEREBRO // CODE RED — WebSocket Sync Server
// =============================================
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
// Use the port provided by Render, or 3000 for local testing
const PORT = process.env.PORT || 3000;

// 1. SERVE STATIC FILES
// This allows your CSS, JS, and images to load correctly
app.use(express.static(__dirname));

// 2. ROUTES
// When you visit the base URL, show the login page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Explicit route for index.html
app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 3. INITIALIZE SERVERS
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer });

// --- Room Management Logic ---
const rooms = {};

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
  return getRoomClients(roomCode).map(c => ({ callsign: c.callsign, role: c.role }));
}

// --- WebSocket Connection Handler ---
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[+] New connection from ${ip}`);

  let clientInfo = null;

  ws.on('message', (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch (e) {
      return;
    }

    switch (msg.type) {
      case 'JOIN': {
        const { roomCode, callsign, role } = msg;
        clientInfo = { ws, callsign, role, roomCode };
        addToRoom(roomCode, clientInfo);

        console.log(`[JOIN] ${callsign} (${role}) → room "${roomCode}"`);

        sendToClient(ws, {
          type: 'JOINED',
          roomCode,
          callsign,
          role,
          peers: getRoomInfo(roomCode).filter(p => p.callsign !== callsign)
        });

        broadcastToRoom(roomCode, {
          type: 'PEER_JOINED',
          callsign,
          role,
          peers: getRoomInfo(roomCode)
        }, ws);
        break;
      }

      // SYNC COMMANDS: Restricted to Broadcaster only
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
          console.log(`[REJECTED] Unauthorized ${msg.type} from ${clientInfo?.callsign || 'Unknown'}`);
          break;
        }

        broadcastToRoom(clientInfo.roomCode, {
          ...msg,
          callsign: clientInfo.callsign,
          serverTime: Date.now()
        }, ws);
        break;
      }

      case 'PING': {
        sendToClient(ws, {
          type: 'PONG',
          clientTimestamp: msg.timestamp,
          serverTime: Date.now()
        });
        break;
      }

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
    }
  });

  ws.on('close', () => {
    const result = removeFromRoom(ws);
    if (result) {
      const { roomCode, client } = result;
      console.log(`[-] ${client.callsign} left room "${roomCode}"`);
      broadcastToRoom(roomCode, {
        type: 'PEER_LEFT',
        callsign: client.callsign,
        peers: getRoomInfo(roomCode)
      });
    }
  });
});

// --- Start the Server ---
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║   CEREBRO SYNC SERVER LIVE ON PORT ${PORT}  ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
const NGROK_TOKEN = 'your_token_here';