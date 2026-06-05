/**
 * Serveur Socket.IO — Auctav Live Sales
 * VERSION STABLE MOBILE + APACHE + SOCKET.IO v2/v3/v4
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { PORT } = require('./config');
const socketMeta = require('./store');
const { log } = require('./utils/logger');

const { getRoomStats, getRooms } = require('./services/roomService');

const { registerAdminHandler } = require('./handlers/adminHandler');
const { registerBidderHandler } = require('./handlers/bidderHandler');
const { registerRoomHandler } = require('./handlers/roomHandler');
const { registerMessageHandler } = require('./handlers/messageHandler');
const { registerDisconnectHandler } = require('./handlers/disconnectHandler');

const {
  registerFollowHandler,
  getFollowersInRoom
} = require('./handlers/followHandler');

const {
  registerScreenHandler,
  getScreensInRoom
} = require('./handlers/screenHandler');

// ─────────────────────────────────────────────────────────────
// EXPRESS
// ─────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

app.use(express.json());

// ─────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://www.auctav.com',
  'https://auctav.com',
  'https://dev.astucom.com',
  'http://localhost',
  'http://127.0.0.1'
];

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: getRoomStats(),
    memory: process.memoryUsage()
  });
});

// Followers debug
app.get('/follow/:room', (req, res) => {
  res.json({
    room: req.params.room,
    followers: getFollowersInRoom(req.params.room)
  });
});

// Screens debug
app.get('/screen/:room', (req, res) => {
  res.json({
    room: req.params.room,
    screens: getScreensInRoom(req.params.room)
  });
});

// ─────────────────────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────────────────────

const io = new Server(server, {

  // IMPORTANT MOBILE / RESEAUX LENTS
  pingInterval: 25000,
  pingTimeout: 60000,

  // IMPORTANT GROS PAYLOADS
  maxHttpBufferSize: 1e8,

  // Compression
  perMessageDeflate: {
    threshold: 1024
  },

  // Compatibilité anciens clients
  allowEIO3: true,

  // IMPORTANT:
  // polling + websocket
  // polling aide énormément réseaux mobile
  transports: ['polling', 'websocket'],

  cors: {
    origin: function(origin, callback) {

      // autorise requêtes sans origin
      // apps mobiles / curl / server-to-server
      if (!origin) {
        return callback(null, true);
      }

      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      log(`CORS bloqué : ${origin}`);

      return callback(new Error('CORS blocked'));
    },

    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ─────────────────────────────────────────────────────────────
// DÉCRÉMENT SERVEUR DES TIMERS — 1x par seconde
//
// Le switcher.php décrémente ses propres inputs toutes les
// secondes, mais entre deux resynchros l'état serveur reste
// figé. Un client qui se reconnecte recevrait alors un timer
// plus grand que la réalité (source du bug "+temps").
//
// Ce setInterval maintient les timers en mémoire serveur
// synchronisés avec le switcher, sans rien émettre.
// La resynchro périodique du switcher (listLot) recale
// automatiquement les deux si un léger écart apparaît.
// ─────────────────────────────────────────────────────────────

setInterval(() => {
  const allRooms = getRooms(); // Map room → state
  allRooms.forEach((state) => {
    if (!state.started) return;
    Object.values(state.lots).forEach((lot) => {
      const t = Number.parseInt(lot.time);
      if (t > 0) lot.time = t - 1;
    });
  });
}, 1000);

// ─────────────────────────────────────────────────────────────
// SOCKET CONNECTION
// ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  log(`+ Connexion : ${socket.id}`);

  socketMeta.set(socket.id, {
    pseudo: 'unknown',
    room: null,
    isAdmin: false
  });

  // ───────────────────────────────────────────────────
  // DEBUG TRANSPORT
  // ───────────────────────────────────────────────────

  log(`Transport : ${socket.conn.transport.name}`);

  socket.conn.on('upgrade', () => {
    log(
        `[UPGRADE] ${socket.id} -> ${socket.conn.transport.name}`
    );
  });

  // ───────────────────────────────────────────────────
  // DEBUG DISCONNECT
  // ───────────────────────────────────────────────────

  socket.on('disconnect', (reason) => {
    log(`- Déconnexion: ${socket.id} (${reason})`);
  });

  socket.on('connect_error', (err) => {
    log(`Connect error ${socket.id}: ${err.message}`);
  });

  // ───────────────────────────────────────────────────
  // HANDLERS
  // ───────────────────────────────────────────────────

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

  log(`Socket.IO server démarré sur port ${PORT}`);

  log(`Mode : PRODUCTION`);

  log(`Health : http://localhost:${PORT}/`);
});

// ─────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────

process.on('SIGTERM', () => {

  log('SIGTERM reçu — arrêt propre');

  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {

  log('SIGINT reçu — arrêt propre');

  server.close(() => {
    process.exit(0);
  });
});