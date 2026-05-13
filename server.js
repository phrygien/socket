/**
 * Serveur Socket.IO — Auctav Live Sales (STABLE VERSION)
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');

const { PORT, ALLOWED_ORIGINS }         = require('./config');
const socketMeta                        = require('./store');
const { log }                           = require('./utils/logger');
const { getRoomStats }                  = require('./services/roomService');

const { registerAdminHandler }          = require('./handlers/adminHandler');
const { registerBidderHandler }         = require('./handlers/bidderHandler');
const { registerRoomHandler }           = require('./handlers/roomHandler');
const { registerMessageHandler }        = require('./handlers/messageHandler');
const { registerDisconnectHandler }     = require('./handlers/disconnectHandler');
const { registerFollowHandler, getFollowersInRoom } = require('./handlers/followHandler');
const { registerScreenHandler, getScreensInRoom }   = require('./handlers/screenHandler');

// ─────────────────────────────────────────────
// APP EXPRESS
// ─────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (_req, res) => {
  res.json({
    status : 'ok',
    rooms  : getRoomStats(),
    uptime : process.uptime()
  });
});

// debug followers
app.get('/follow/:room', (req, res) => {
  res.json({
    room      : req.params.room,
    followers : getFollowersInRoom(req.params.room)
  });
});

// debug screens
app.get('/screen/:room', (req, res) => {
  res.json({
    room    : req.params.room,
    screens : getScreensInRoom(req.params.room)
  });
});

// ─────────────────────────────────────────────
// SOCKET.IO OPTIMISÉ
// ─────────────────────────────────────────────

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS || "*",
    methods: ["GET", "POST"]
  },

  allowEIO3: true,

  // 🔥 STABILITY CRITIQUE
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 20000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: false
});

// ─────────────────────────────────────────────
// ANTI BURST CONNECTION (IMPORTANT)
// ─────────────────────────────────────────────

let connectionsThisSecond = 0;

setInterval(() => {
  connectionsThisSecond = 0;
}, 1000);

// ─────────────────────────────────────────────
// SOCKET CONNECTION
// ─────────────────────────────────────────────

io.on('connection', (socket) => {

  connectionsThisSecond++;

  // 🚨 protection surcharge
  if (connectionsThisSecond > 80) {
    log(`⚠ DROP ${socket.id} (burst protection)`);
    socket.disconnect(true);
    return;
  }

  log(`+ Connexion : ${socket.id}`);

  socketMeta.set(socket.id, {
    pseudo: 'unknown',
    room: null,
    isAdmin: false
  });

  // 🔥 HANDLERS DELAYED (évite crash CPU spike)
  setTimeout(() => {
    registerAdminHandler(io, socket);
    registerBidderHandler(io, socket);
    registerRoomHandler(io, socket);
    registerMessageHandler(io, socket);
    registerFollowHandler(io, socket);
    registerScreenHandler(io, socket);
    registerDisconnectHandler(io, socket);
  }, 5);
});

// ─────────────────────────────────────────────
// DEBUG MONITORING
// ─────────────────────────────────────────────

setInterval(() => {
  log(`📊 Rooms: ${io.sockets.adapter.rooms.size}`);
  log(`📊 Clients: ${io.engine.clientsCount}`);
}, 30000);

// ─────────────────────────────────────────────
// ERROR HANDLING GLOBAL
// ─────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  console.error("🔥 uncaughtException:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("🔥 unhandledRejection:", err);
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────

server.listen(PORT, () => {
  log(`Socket.IO démarré sur port ${PORT}`);
  log(`Status : http://localhost:${PORT}/`);
});

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────

process.on('SIGTERM', () => {
  log('SIGTERM reçu — fermeture propre');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  log('SIGINT reçu — fermeture propre');
  server.close(() => process.exit(0));
});