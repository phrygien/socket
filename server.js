/**
 * Serveur Socket.IO — Auctav Live Sales
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  FLUX PRINCIPAL                                                     │
 * │                                                                     │
 * │  Admin (switcher.php)                                               │
 * │    → emit('admin', pseudo)                                          │
 * │    → emit('joinroom', room)                                         │
 * │      ⤷ serveur broadcast userList({admin: socketId}) à la salle    │
 * │    → emit('getMsgRoom',  {room, type, msg, name})  diffusion salle  │
 * │    → emit('getMsgPrivate',{toid, type, msg, name}) message ciblé    │
 * │                                                                     │
 * │  Bidder (vente_list.php)                                            │
 * │    → emit('joinroom', room)                                         │
 * │    → emit('username', pseudo)                                       │
 * │      ⤷ serveur répond userList({admin: socketId}) en privé         │
 * │    → emit('getMsgPrivate', {toid:idAdmin, type:'reconnection', …})  │
 * │    → emit('getMsgPrivate', {toid:idAdmin, type:'doEncheres',   …})  │
 * │    → emit('getMsgPrivate', {toid:idAdmin, type:'exit',         …})  │
 * │    → emit('getMsgPrivate', {toid:idAdmin, type:'connected',    …})  │
 * │    ← on('userList',  {admin})   sait à qui envoyer les enchères     │
 * │    ← on('sendMsg',   {type, msg, name, from})  mises à jour lot     │
 * │                                                                     │
 * │  Déconnexion admin → broadcast userList({admin: null})              │
 * │    ⤷ bidders cachent le formulaire d'enchère                       │
 * │                                                                     │
 * │  Follower (follow.php)                                              │
 * │    → emit('joinroom', 'auctav_follow')                              │
 * │    → emit('username', 'Follow_<timestamp>')                         │
 * │    ← on('userList', {admin})  → sait à qui envoyer les pings       │
 * │    → getMsgPrivate({toid:idAdmin, type:'follow', msg:{state:true}}) │
 * │        (heartbeat toutes les 3 min)                                 │
 * │    ← on('sendMsg', {type:'message', msg:{text,style}})  log texte  │
 * │    ← on('sendMsg', {type:'users',   msg:{text}})  liste bidders    │
 * │    ← on('sendMsg', {type:'follow'})  confirmation heartbeat        │
 * │                                                                     │
 * │  Screen (screen.php)                                                │
 * │    → emit('joinroom', 'auctav_screen')                              │
 * │    → emit('username', 'Screen_<timestamp>')                         │
 * │    ← on('userList', {admin})                                        │
 * │        → admin présent  : getMsgPrivate({type:'getScreen'}) + show  │
 * │        → admin absent   : hide                                      │
 * │    ← on('sendMsg', {type:'numLot',      msg:{numLot, nom, pere,     │
 * │                                              mere, presentateur,    │
 * │                                              infos_suppl, tva,      │
 * │                                              from, img, prices[]}}) │
 * │    ← on('sendMsg', {type:'previousLot', msg:{numLot, prices[]}})    │
 * │                                                                     │
 * │  Results (results.php)                                              │
 * │    → emit('joinroom', 'auctav<saleId>')  ← même salle que les      │
 * │    → emit('username', 'RESULTS')           bidders                  │
 * │    ← on('sendMsg', {type:'closeEnchere',                            │
 * │                      msg:{numLot, statut, price, toid}})            │
 * │        → affiche statut + prix adjugé du lot                        │
 * │    ← on('sendMsg', {type:'updateLot',                               │
 * │                      msg:{numLot, statut, price, toid}})            │
 * │        → même traitement que closeEnchere                           │
 * │    (pas de handler dédié : flux géré par roomHandler/getMsgRoom)    │
 * └─────────────────────────────────────────────────────────────────────┘
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');

const { PORT, ALLOWED_ORIGINS }         = require('./config');
const socketMeta                        = require('./store');
const { log }                           = require('./utils/logger');
const { getRoomStats }                  = require('./services/roomService');
const { registerAdminHandler }                        = require('./handlers/adminHandler');
const { registerBidderHandler }                       = require('./handlers/bidderHandler');
const { registerRoomHandler }                         = require('./handlers/roomHandler');
const { registerMessageHandler }                      = require('./handlers/messageHandler');
const { registerDisconnectHandler }                   = require('./handlers/disconnectHandler');
const { registerFollowHandler, getFollowersInRoom }   = require('./handlers/followHandler');
const { registerScreenHandler, getScreensInRoom }     = require('./handlers/screenHandler');

// ─── App Express ──────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Endpoint de vérification
app.get('/', (_req, res) => {
  res.json({
    status : 'ok',
    rooms  : getRoomStats(),
    uptime : process.uptime()
  });
});

// Endpoint debug : followers connectés dans une salle
// GET /follow/auctav_follow
app.get('/follow/:room', (req, res) => {
  res.json({
    room      : req.params.room,
    followers : getFollowersInRoom(req.params.room)
  });
});

// Endpoint debug : écrans connectés dans une salle
// GET /screen/auctav_screen
app.get('/screen/:room', (req, res) => {
  res.json({
    room    : req.params.room,
    screens : getScreensInRoom(req.params.room)
  });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: {
    origin : ALLOWED_ORIGINS,
    methods: ['GET', 'POST']
  },
  // Compatibilité avec les anciens clients socket.io v2/v3
  allowEIO3: true
});

io.on('connection', (socket) => {
  log(`+ Connexion  : ${socket.id}`);
  socketMeta.set(socket.id, { pseudo: 'unknown', room: null, isAdmin: false });

  registerAdminHandler(io, socket);
  registerBidderHandler(io, socket);
  registerRoomHandler(io, socket);
  registerMessageHandler(io, socket);
  registerFollowHandler(io, socket);
  registerScreenHandler(io, socket);
  registerDisconnectHandler(io, socket);
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  log(`Serveur Socket.IO démarré sur le port ${PORT}`);
  log(`Statut : http://localhost:${PORT}/`);
});

// Gestion propre de l'arrêt
process.on('SIGTERM', () => {
  log('SIGTERM reçu — fermeture propre');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  log('SIGINT reçu — fermeture propre');
  server.close(() => process.exit(0));
});
