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

const PORT = 3000;
const path = require('path');

// Tell Express to serve files from the current directory
app.use(express.static(__dirname));

// Send login.html as the default page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// HTTP server — serves the HTML file
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('index.html not found. Place index.html in the same folder as server.js');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// WebSocket server
const wss = new WebSocket.Server({ server: httpServer });

// Rooms: { roomCode: [ { ws, callsign, role } ] }
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
        const { roomCode, callsign, role } = msg;
        clientInfo = { ws, callsign, role, roomCode };
        addToRoom(roomCode, clientInfo);

        console.log(`[JOIN] ${callsign} (${role}) → room "${roomCode}" | ${getRoomClients(roomCode).length} clients`);

        // Confirm join to the client
        sendToClient(ws, {
          type: 'JOINED',
          roomCode,
          callsign,
          role,
          peers: getRoomInfo(roomCode).filter(p => p.callsign !== callsign)
        });

        // Notify others in the room
        broadcastToRoom(roomCode, {
          type: 'PEER_JOINED',
          callsign,
          role,
          peers: getRoomInfo(roomCode)
        }, ws);

        break;
      }

      // Broadcaster sends playback command — relay to all listeners
      // Broadcaster sends playback command — relay to all listeners
      case 'PLAY':
      case 'PAUSE':
      case 'SEEK':
      case 'STOP':
      // YouTube commands
      case 'YT_PLAY':
      case 'YT_PAUSE':
      case 'YT_SEEK':
      case 'YT_STOP':
      case 'YT_LOAD':
      case 'SOURCE_SWITCH': {
        if (!clientInfo) break;

        // STRICT ROLE CHECK: Reject if the sender is not a broadcaster
        if (clientInfo.role !== 'broadcaster') {
          console.log(`[REJECTED] Unauthorized ${msg.type} attempt from Listener: ${clientInfo.callsign}`);
          break; 
        }

        console.log(`[${msg.type}] from ${clientInfo.callsign} | t=${msg.time?.toFixed(2)}s | room "${clientInfo.roomCode}"`);
        
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
httpServer.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';

  // Find local network IP
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIP = net.address;
        break;
      }
    }
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   CEREBRO // CODE RED SYNC SERVER        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${localIP}:${PORT}`);
  console.log(`\n  Share this URL with other devices on WiFi:`);
  console.log(`  → http://${localIP}:${PORT}\n`);
  console.log('  Waiting for connections...\n');
});
