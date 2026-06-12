// ─── Room Handler ─────────────────────────────────────────────────────────────
// Gestion des salles et diffusion des messages
// Compatible avec switcher.php (Admin) et ventes_live.php (Clients)

const socketMeta                              = require('../store');
const { log }                                 = require('../utils/logger');
const { getAdminOfRoom, broadcastUserList }   = require('../services/roomService');
const { updateSaleEndTimer, clearSaleEndTimer, getSaleEndRemaining } = require('../services/saleEndService');

// ============================================
// CONFIGURATION
// ============================================
const MAX_TIME = 3600;
const MAX_PRICE = 10000000;
const MIN_PRICE = 0;
const MIN_LOT = 1;
const MAX_LOT = 999;
const EXTRA_TIME_THRESHOLD = 1;
const EXTRA_TIME_DURATION = 30;
const MAX_EXTRA_TIME = 300;

// ============================================
// STOCKAGE DES SALLES
// ============================================
const saleState = new Map();

function getLotState(room, lotNum) {
  if (!saleState.has(room)) {
    saleState.set(room, {
      lots: new Map(),
      ended: false,
      maxTimer: 0,
      lastActivity: Date.now(),
      saleEnded: false
    });
  }
  const state = saleState.get(room);
  if (!state.lots.has(lotNum)) {
    state.lots.set(lotNum, {
      currentTime: 0,
      extraTimeCount: 0,
      lastExtraTimeAt: 0,
      isActive: false,
      extratime: false,
      closed: false
    });
  }
  return state.lots.get(lotNum);
}

function updateLotTime(io, room, lotNum, newTime, isExtraTime = false) {
  const lotState = getLotState(room, lotNum);
  const oldTime = lotState.currentTime;
  lotState.currentTime = newTime;
  lotState.extratime = isExtraTime;

  if (isExtraTime) {
    lotState.extraTimeCount++;
    lotState.lastExtraTimeAt = Date.now();
  }
  lotState.isActive = newTime > 0;

  updateRoomMaxTimer(io, room);

  log(`[LOT] Room ${room} Lot ${lotNum}: ${oldTime}s -> ${newTime}s${isExtraTime ? ' (EXTRA TIME)' : ''}`);

  return lotState;
}

function closeAllLots(io, room) {
  const state = saleState.get(room);
  if (!state) return;

  log(`[CLOSE] Fermeture de tous les lots dans la salle ${room}`, "SALE");

  // Marquer tous les lots comme fermés
  for (const [lotNum, lotState] of state.lots) {
    lotState.currentTime = 0;
    lotState.isActive = false;
    lotState.closed = true;

    // Envoyer un message numLot avec time=0 pour chaque lot
    io.to(room).emit('sendMsg', {
      type: 'numLot',
      msg: {
        numLot: lotNum,
        price: 0,
        time: 0,
        extratime: false,
        statut: 'sold',
        closed: true
      },
      name: 'System',
      from: 'system'
    });
  }

  state.maxTimer = 0;
  state.ended = true;
  state.saleEnded = true;

  // Nettoyer le timer global
  clearSaleEndTimer(room);
}

function updateRoomMaxTimer(io, room) {
  const state = saleState.get(room);
  if (!state) return 0;

  // Si la vente est terminée, retourner 0
  if (state.saleEnded || state.ended) return 0;

  let maxTimer = 0;
  for (const [, lotState] of state.lots) {
    if (!lotState.closed && lotState.currentTime > maxTimer) {
      maxTimer = lotState.currentTime;
    }
  }
  state.maxTimer = maxTimer;
  state.lastActivity = Date.now();

  log(`[TIMER MAX] Room ${room}: ${maxTimer}s`);

  if (maxTimer > 0) {
    updateSaleEndTimer(io, room, maxTimer);
  } else if (maxTimer === 0 && !state.ended && !state.saleEnded) {
    log(`[SALE] Condition de fin de vente atteinte pour ${room}`, "SALE");
    triggerSaleEnd(io, room);
  }

  return maxTimer;
}

function shouldTriggerExtraTime(room, lotNum, currentTime) {
  if (currentTime > 1) return false;
  if (currentTime <= 0) return false;

  const state = saleState.get(room);
  if (state && (state.ended || state.saleEnded)) return false;

  const lotState = getLotState(room, lotNum);
  if (lotState.closed) return false;

  return true;
}

function calculateExtraTime(currentTime, extraTimeCount) {
  let newTime = currentTime + EXTRA_TIME_DURATION;
  if (newTime > MAX_EXTRA_TIME) {
    newTime = MAX_EXTRA_TIME;
  }
  return newTime;
}

function triggerSaleEnd(io, room) {
  const state = saleState.get(room);
  if (!state || state.ended || state.saleEnded) return;

  state.ended = true;
  state.saleEnded = true;
  clearSaleEndTimer(room);

  // Envoyer le signal de fin de vente
  io.to(room).emit('sendMsg', {
    type: 'saleEnded',
    msg: {
      message: 'La vente est terminee',
      timestamp: Date.now(),
      redirectUrl: '/resultats.php',
      allLotsClosed: true
    },
    name: 'System',
    from: 'system'
  });

  log(`[SALE] FIN DE VENTE - Salle ${room}`, "SALE");
  return state;
}

function isSaleEnded(room) {
  const state = saleState.get(room);
  return state ? (state.ended || state.saleEnded) : false;
}

// ============================================
// VALIDATION
// ============================================

const ADMIN_ONLY_TYPES = [
  'numLot', 'listLot', 'previousLot', 'closeEnchere',
  'updateLot', 'users', 'saleEnded'
];

function validateMessage(data) {
  if (!data || !data.msg) return true;

  if (data.type === 'numLot' || data.type === 'listLot') {
    if (data.msg.time !== undefined) {
      const time = parseInt(data.msg.time);
      if (isNaN(time) || time < 0 || time > MAX_TIME) {
        log(`[VALIDATION] Timer invalide: ${time}`, "ERROR");
        return false;
      }
    }
    if (data.msg.price !== undefined) {
      const price = parseInt(data.msg.price);
      if (isNaN(price) || price < MIN_PRICE || price > MAX_PRICE) {
        log(`[VALIDATION] Prix invalide: ${price}`, "ERROR");
        return false;
      }
    }
    if (data.msg.numLot !== undefined) {
      const lotNum = parseInt(data.msg.numLot);
      if (isNaN(lotNum) || lotNum < MIN_LOT || lotNum > MAX_LOT) {
        log(`[VALIDATION] Lot invalide: ${lotNum}`, "ERROR");
        return false;
      }
    }
  }
  return true;
}

// ============================================
// REGISTER ROOM HANDLER
// ============================================

function registerRoomHandler(io, socket) {

  socket.on('joinroom', (room) => {
    const meta = socketMeta.get(socket.id);
    const isAdmin = meta?.isAdmin === true;

    if (meta?.room) {
      const oldRoom = meta.room;
      socket.leave(oldRoom);
      if (meta.isAdmin) broadcastUserList(io, oldRoom);
    }

    socket.join(room);
    if (meta) meta.room = room;

    log(`[joinroom] ${socket.id} -> ${room} (admin=${isAdmin})`);

    if (isAdmin) {
      broadcastUserList(io, room);
      socket.emit('adminJoined', { room: room, status: 'ok' });
    } else {
      const adminId = getAdminOfRoom(room);
      socket.emit('userList', { admin: adminId });

      // Envoyer l'état de fin de vente si besoin
      if (isSaleEnded(room)) {
        socket.emit('sendMsg', {
          type: 'saleEnded',
          msg: {
            message: 'La vente est terminee',
            redirectUrl: '/resultats.php',
            allLotsClosed: true
          },
          name: 'System',
          from: 'system'
        });
      }

      const remaining = getSaleEndRemaining(room);
      if (remaining !== null && !isSaleEnded(room)) {
        socket.emit('saleEndTimer', {
          room: room,
          remainingSeconds: remaining,
          ended: remaining <= 0
        });
      }
    }
  });

  socket.on('leaveroom', (room) => {
    const meta = socketMeta.get(socket.id);
    socket.leave(room);
    if (meta) meta.room = null;
    if (meta?.isAdmin) broadcastUserList(io, room);
  });

  socket.on('saleEndSync', () => {
    const meta = socketMeta.get(socket.id);
    const room = meta?.room;

    if (room && isSaleEnded(room)) {
      socket.emit('sendMsg', {
        type: 'saleEnded',
        msg: {
          message: 'La vente est terminee',
          redirectUrl: '/resultats.php',
          allLotsClosed: true
        },
        name: 'System',
        from: 'system'
      });
    }

    const remaining = room ? getSaleEndRemaining(room) : null;
    if (remaining !== null && !isSaleEnded(room)) {
      socket.emit('saleEndTimer', {
        room: room,
        remainingSeconds: remaining,
        ended: remaining <= 0
      });
    } else {
      socket.emit('saleEndTimer', { active: false });
    }
  });

  socket.on('getMsgRoom', (data) => {
    if (!data || !data.room) {
      log(`[ERROR] getMsgRoom sans room`, "ERROR");
      return;
    }

    const meta = socketMeta.get(socket.id);
    const isAdmin = meta?.isAdmin === true;

    if (ADMIN_ONLY_TYPES.includes(data.type) && !isAdmin) {
      log(`[SECURITY] REFUSE: ${socket.id} a tente d'envoyer ${data.type} sans droits admin`, "ERROR");
      socket.emit('error', {
        message: 'Non autorise',
        type: data.type
      });
      return;
    }

    if (!validateMessage(data)) {
      socket.emit('error', { message: 'Valeurs invalides', type: data.type });
      return;
    }

    let finalMsg = { ...data.msg };

    // TRAITEMENT NUMEROS DE LOT (ADMIN)
    if (data.type === 'numLot' && isAdmin && data.msg) {
      const lotNum = data.msg.numLot;
      const newTime = parseInt(data.msg.time) || 0;
      const isExtraTime = data.msg.extratime === true || data.msg.extratime === "true";

      const lotState = getLotState(data.room, lotNum);
      lotState.currentTime = newTime;
      lotState.extratime = isExtraTime;
      if (isExtraTime) lotState.extraTimeCount++;

      updateRoomMaxTimer(io, data.room);

      finalMsg.extratime = isExtraTime;
      finalMsg.extraTimeCount = lotState.extraTimeCount;
    }

    // INITIALISATION LISTE LOTS
    if (data.type === 'listLot' && data.msg && data.msg.list && isAdmin) {
      for (const lot of data.msg.list) {
        const lotNum = lot.numLot;
        const lotTime = parseInt(lot.time) || 0;
        const isExtraTime = lot.extratime === true || lot.extratime === "true";
        const lotState = getLotState(data.room, lotNum);
        lotState.currentTime = lotTime;
        lotState.extratime = isExtraTime;
        lotState.isActive = lotTime > 0;
        lotState.closed = false;
      }
      updateRoomMaxTimer(io, data.room);
      log(`[INIT] ${data.msg.list.length} lots initialises`);
    }

    // FIN DE VENTE - 🔥 FERMER TOUS LES LOTS
    if (data.type === 'saleEnded' && isAdmin) {
      log(`[ADMIN] Fin de vente manuelle - Fermeture de tous les lots`, "SALE");
      closeAllLots(io, data.room);
      triggerSaleEnd(io, data.room);
    }

    const payload = {
      type: data.type || '',
      msg: finalMsg,
      name: data.name || meta?.pseudo || 'unknown',
      from: socket.id,
      isAdmin: isAdmin
    };

    io.to(data.room).emit('sendMsg', payload);
  });

  socket.on('getMsgPrivate', (data) => {
    if (!data || !data.toid) {
      log(`[ERROR] getMsgPrivate sans toid`, "ERROR");
      return;
    }

    const meta = socketMeta.get(socket.id);
    const isAdmin = meta?.isAdmin === true;
    const room = meta?.room;

    // 🔥 VERIFIER SI LA VENTE EST TERMINEE
    if (data.type === 'doEncheres' && data.msg && !isAdmin) {
      if (room && isSaleEnded(room)) {
        log(`[BLOCKED] Enchere refusee - Vente terminee pour ${data.name}`, "WARNING");
        socket.emit('sendMsg', {
          type: 'confirmEnchere',
          msg: { lot: data.msg.lot, state: false, reason: "Vente terminee" },
          name: 'System',
          from: 'system'
        });
        return;
      }
    }

    let finalMsg = { ...data.msg };

    if (data.type === 'doEncheres' && data.msg && !isAdmin) {
      const lotNum = data.msg.lot;
      const currentTime = parseInt(data.msg.currentTime) || 0;
      const clientRequestExtraTime = data.msg.triggerExtraTime === true;

      if (room) {
        const shouldTrigger = clientRequestExtraTime && shouldTriggerExtraTime(room, lotNum, currentTime);

        if (shouldTrigger) {
          const lotState = getLotState(room, lotNum);
          const newTime = calculateExtraTime(currentTime, lotState.extraTimeCount);
          updateLotTime(io, room, lotNum, newTime, true);

          finalMsg.extraTimeTriggered = true;
          finalMsg.extraTimeNewTime = newTime;
          finalMsg.extratime = true;

          log(`[EXTRA TIME] Enchere sur lot ${lotNum} a declenche Extra Time!`, "SUCCESS");
        }
      }

      log(`[PRIVATE ENCHERE] ${data.name} -> lot ${lotNum} montant: ${data.msg.myEnchere}€`);
    }

    const payload = {
      type: data.type || '',
      msg: finalMsg,
      name: data.name || meta?.pseudo || 'unknown',
      from: socket.id
    };

    io.to(data.toid).emit('sendMsg', payload);
  });
}

module.exports = {
  registerRoomHandler,
  isSaleEnded,
  closeAllLots,
  triggerSaleEnd
};