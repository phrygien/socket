/**
 * Serveur Socket.IO — Auctav Live Sales (FIX CORS + PRODUCTION READY)
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { PORT } = require('./config');
const socketMeta = require('./store');
const { log } = require('./utils/logger');

const { getRoomStats } = require('./services/roomService');

const { registerAdminHandler } = require('./handlers/adminHandler');
const { registerBidderHandler } = require('./handlers/bidderHandler');
const { registerRoomHandler } = require('./handlers/roomHandler');
const { registerMessageHandler } = require('./handlers/messageHandler');
const { registerDisconnectHandler } = require('./handlers/disconnectHandler');
const { registerFollowHandler, getFollowersInRoom } = require('./handlers/followHandler');
const { registerScreenHandler, getScreensInRoom } = require('./handlers/screenHandler');

// ─────────────────────────────────────────────────────────────
// CONFIG ORIGINS (IMPORTANT FIX CORS)
// ─────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  "https://www.auctav.com",
  "https://auctav.com",
  "http://localhost",
  "http://127.0.0.1"
];

// ─────────────────────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

// pas nécessaire pour socket.io (on le garde optionnel)
app.use(express.json());

// Health check
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    rooms: getRoomStats(),
    uptime: process.uptime()
  });
});

// debug followers
app.get('/follow/:room', (req, res) => {
  res.json({
    room: req.params.room,
    followers: getFollowersInRoom(req.params.room)
  });
});

// debug screens
app.get('/screen/:room', (req, res) => {
  res.json({
    room: req.params.room,
    screens: getScreensInRoom(req.params.room)
  });
});

// ─────────────────────────────────────────────────────────────
// SOCKET.IO SERVER (FIX CORS HERE)
// ─────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      // autorise appels server-to-server (pas de origin)
      if (!origin) return callback(null, true);

      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      log(`CORS bloqué: ${origin}`);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ['GET', 'POST'],
    credentials: true
  },

  // IMPORTANT: compat client socket.io v2 (EIO=3)
  allowEIO3: true,

  transports: ['websocket', 'polling']
});

// ─────────────────────────────────────────────────────────────
// CONNECTION HANDLER
// ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  log(`+ Connexion : ${socket.id}`);

  socketMeta.set(socket.id, {
    pseudo: 'unknown',
    room: null,
    isAdmin: false
  });

  // handlers
  registerAdminHandler(io, socket);
  registerBidderHandler(io, socket);
  registerRoomHandler(io, socket);
  registerMessageHandler(io, socket);
  registerFollowHandler(io, socket);
  registerScreenHandler(io, socket);
  registerDisconnectHandler(io, socket);
});

// ─────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  log(`Socket.IO server running on port ${PORT}`);
  log(`http://localhost:${PORT}/`);
});

// ─────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  log('SIGTERM reçu — arrêt serveur');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  log('SIGINT reçu — arrêt serveur');
  server.close(() => process.exit(0));
});