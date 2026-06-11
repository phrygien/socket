// ─── Room Handler ─────────────────────────────────────────────────────────────

const socketMeta                              = require('../store');
const { log }                                 = require('../utils/logger');
const { getAdminOfRoom, broadcastUserList }   = require('../services/roomService');

const rateLimit = new Map();

function checkRateLimit(socketId, type) {
  const key = `${socketId}_${type}`;
  const now = Date.now();

  if (!rateLimit.has(key)) {
    rateLimit.set(key, []);
  }

  const timestamps = rateLimit.get(key);
  const recent = timestamps.filter(t => now - t < 1000);

  if (recent.length > 10) {
    log(`RATE LIMIT: ${socketId} spamme ${type}`);
    return false;
  }

  timestamps.push(now);
  rateLimit.set(key, timestamps);

  setTimeout(() => {
    const current = rateLimit.get(key);
    if (current) {
      const filtered = current.filter(t => now - t < 1000);
      if (filtered.length === 0) {
        rateLimit.delete(key);
      } else {
        rateLimit.set(key, filtered);
      }
    }
  }, 1000);

  return true;
}

function registerRoomHandler(io, socket) {

  socket.on('joinroom', (room) => {
    const meta = socketMeta.get(socket.id);

    if (meta?.room) {
      const oldRoom = meta.room;
      socket.leave(oldRoom);
      if (meta.isAdmin) broadcastUserList(io, oldRoom);
    }

    socket.join(room);
    if (meta) meta.room = room;

    log(`[joinroom] : ${socket.id} -> ${room} (admin=${meta?.isAdmin})`);

    if (meta?.isAdmin) {
      broadcastUserList(io, room);
    } else {
      const adminId = getAdminOfRoom(room);
      socket.emit('userList', { admin: adminId });
      log(`[userList->${socket.id}] admin=${adminId || 'none'}`);
    }
  });

  /**
   * Diffusion d'un message vers toute la salle.
   * Seul l'ADMIN peut envoyer des commandes de controle
   */
  socket.on('getMsgRoom', (data) => {
    if (!data || !data.room) return;

    // Verification critique : recuperer le statut admin
    const meta = socketMeta.get(socket.id);
    const isAdmin = meta?.isAdmin === true;

    // Types de messages qui necessitent des droits ADMIN
    const adminOnlyTypes = [
      'numLot',        // Controle du timer
      'listLot',       // Envoi de la liste des lots
      'previousLot',   // Lot precedent
      'closeEnchere',  // Cloture enchere
      'updateLot',     // Mise a jour lot
      'users'          // Liste des utilisateurs
    ];

    // Verification ADMIN obligatoire
    if (adminOnlyTypes.includes(data.type) && !isAdmin) {
      log(`ALERTE SECURITE: ${socket.id} (admin=${isAdmin}) a tente d'envoyer ${data.type} sans droits`);

      // Envoyer une erreur au client
      socket.emit('error', {
        message: 'Non autorise - Droits administrateur requis',
        type: data.type
      });

      return; // Bloquer le message
    }

    // Rate limiting
    if (!checkRateLimit(socket.id, data.type)) {
      socket.emit('error', { message: 'Trop de messages' });
      return;
    }

    // Validation des valeurs (anti-hack)
    if (data.type === 'numLot' && data.msg) {

      // Verifier que le timer est raisonnable
      if (data.msg.time !== undefined) {
        const time = parseInt(data.msg.time);
        const MAX_TIME = 3600; // 1 heure max
        const MIN_TIME = 0;

        if (isNaN(time) || time < MIN_TIME || time > MAX_TIME) {
          log(`ALERTE SECURITE: ${socket.id} a tente d'envoyer un timer invalide: ${time}`);
          socket.emit('error', { message: 'Timer invalide' });
          return;
        }
      }

      // Verifier que le prix est raisonnable
      if (data.msg.price !== undefined) {
        const price = parseInt(data.msg.price);
        const MAX_PRICE = 10000000; // 10 millions max
        const MIN_PRICE = 0;

        if (isNaN(price) || price < MIN_PRICE || price > MAX_PRICE) {
          log(`ALERTE SECURITE: ${socket.id} a tente d'envoyer un prix invalide: ${price}`);
          socket.emit('error', { message: 'Prix invalide' });
          return;
        }
      }

      // Verifier que le numero de lot est valide
      if (data.msg.numLot !== undefined) {
        const lotNum = parseInt(data.msg.numLot);
        if (isNaN(lotNum) || lotNum < 1 || lotNum > 999) {
          log(`ALERTE SECURITE: ${socket.id} a tente d'envoyer un lot invalide: ${lotNum}`);
          socket.emit('error', { message: 'Lot invalide' });
          return;
        }
      }
    }

    const payload = {
      type : data.type || '',
      msg  : data.msg  || {},
      name : data.name || meta?.pseudo || 'unknown',
      from : socket.id
    };

    // Log securise
    if (adminOnlyTypes.includes(data.type)) {
      log(`[ADMIN->room:${data.room}] type="${data.type}" from=${socket.id}`);
    } else {
      log(`[room->${data.room}] type="${data.type}" from=${socket.id} (public)`);
    }

    // Diffuser a TOUS les membres de la salle
    io.to(data.room).emit('sendMsg', payload);
  });
}

module.exports = { registerRoomHandler };