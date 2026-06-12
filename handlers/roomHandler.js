// ─── Room Handler ─────────────────────────────────────────────────────────────
// Gestion des salles et diffusion des messages
// Compatible avec switcher.php (Admin) et ventes_live.php (Clients)
// SEUL L'ADMIN PEUT MODIFIER LES TIMERS VIA switcher.php
// AVEC GESTION COMPLETE DE L'EXTRA TIME (59s si enchère dans les 60 dernières secondes)
// Version finale - Integre avec le serveur Auctav Live Sales

const socketMeta                              = require('../store');
const { log }                                 = require('../utils/logger');
const { getAdminOfRoom, broadcastUserList }   = require('../services/roomService');
const { updateSaleEndTimer, clearSaleEndTimer, getSaleEndRemaining } = require('../services/saleEndService');

// ============================================
// CONFIGURATION SECURITE
// ============================================
const MAX_TIME = 3600;           // 1 heure max
const MAX_PRICE = 10000000;      // 10 millions max
const MIN_PRICE = 0;
const MIN_LOT = 1;
const MAX_LOT = 999;

// ============================================
// CONFIGURATION EXTRA TIME
// ============================================
const EXTRA_TIME_THRESHOLD = 60;      // Déclencher si temps <= 60 secondes
const EXTRA_TIME_DURATION = 59;       // Ajouter 59 secondes
const MAX_EXTRA_TIME = 3600;          // Max 1 heure avec extra time

// ============================================
// STOCKAGE DES SALLES ET TIMERS
// ============================================
const saleState = new Map();      // key: room, value: { lots, ended, maxTimer, lastActivity }

// ============================================
// FONCTIONS DE GESTION DES SALLES
// ============================================

function getLotState(room, lotNum) {
  if (!saleState.has(room)) {
    saleState.set(room, {
      lots: new Map(),
      ended: false,
      maxTimer: 0,
      lastActivity: Date.now()
    });
  }
  const state = saleState.get(room);
  if (!state.lots.has(lotNum)) {
    state.lots.set(lotNum, {
      currentTime: 0,
      extraTimeCount: 0,
      lastExtraTimeAt: 0,
      isActive: false
    });
  }
  return state.lots.get(lotNum);
}

function updateLotTime(io, room, lotNum, newTime, isExtraTime = false) {
  const lotState = getLotState(room, lotNum);
  const oldTime = lotState.currentTime;
  lotState.currentTime = newTime;
  if (isExtraTime) {
    lotState.extraTimeCount++;
    lotState.lastExtraTimeAt = Date.now();
  }
  lotState.isActive = newTime > 0;

  // Mettre à jour le timer max de la salle
  updateRoomMaxTimer(io, room);

  log(`[LOT] Room ${room} Lot ${lotNum}: ${oldTime}s -> ${newTime}s${isExtraTime ? ' (EXTRA TIME #' + lotState.extraTimeCount + ')' : ''}`);

  return lotState;
}

function updateRoomMaxTimer(io, room) {
  const state = saleState.get(room);
  if (!state) return 0;

  let maxTimer = 0;
  for (const [, lotState] of state.lots) {
    if (lotState.currentTime > maxTimer) {
      maxTimer = lotState.currentTime;
    }
  }
  state.maxTimer = maxTimer;
  state.lastActivity = Date.now();

  log(`[TIMER MAX] Room ${room}: ${maxTimer}s`);

  // Mettre à jour le timer global de fin de vente
  if (maxTimer > 0) {
    updateSaleEndTimer(io, room, maxTimer);
  } else if (maxTimer === 0 && !state.ended) {
    log(`[SALE] Condition de fin de vente atteinte pour ${room}`, "SALE");
    triggerSaleEnd(io, room);
  }

  return maxTimer;
}

function shouldTriggerExtraTime(room, lotNum, currentTime) {
  if (currentTime <= 0) return false;

  const state = saleState.get(room);
  if (state && state.ended) return false;

  const shouldTrigger = currentTime <= EXTRA_TIME_THRESHOLD;

  if (shouldTrigger) {
    log(`[EXTRA TIME] Condition remplie pour lot ${lotNum} - Temps: ${currentTime}s <= ${EXTRA_TIME_THRESHOLD}s`);
  }

  return shouldTrigger;
}

function calculateExtraTime(currentTime, extraTimeCount) {
  let newTime = currentTime + EXTRA_TIME_DURATION;

  if (newTime > MAX_EXTRA_TIME) {
    newTime = MAX_EXTRA_TIME;
  }

  log(`[EXTRA TIME] Calcul: ${currentTime}s + ${EXTRA_TIME_DURATION}s = ${newTime}s (${extraTimeCount + 1}eme extra time)`);

  return newTime;
}

function triggerSaleEnd(io, room) {
  const state = saleState.get(room);
  if (!state || state.ended) return;

  state.ended = true;
  state.lastActivity = Date.now();

  // Nettoyer le timer global
  clearSaleEndTimer(room);

  // Envoyer le signal de fin de vente à tous les clients
  io.to(room).emit('sendMsg', {
    type: 'saleEnded',
    msg: {
      message: 'La vente est terminee - Tous les lots ont ete traites',
      timestamp: Date.now(),
      redirectUrl: '/resultats.php'
    },
    name: 'System',
    from: 'system'
  });

  log(`[SALE] FIN DE VENTE DECLENCHEE - Salle ${room}`, "SALE");

  return state;
}

function resetRoomState(room) {
  if (saleState.has(room)) {
    const state = saleState.get(room);
    if (state.endTimeout) clearTimeout(state.endTimeout);
    saleState.delete(room);
  }
  clearSaleEndTimer(room);
  log(`[RESET] Salle ${room} reinitialisee`);
}

function getRoomTimers(room) {
  const state = saleState.get(room);
  if (!state) return {};

  const result = {};
  for (const [lot, lotState] of state.lots) {
    result[lot] = {
      time: lotState.currentTime,
      extraTimeCount: lotState.extraTimeCount,
      isActive: lotState.isActive
    };
  }
  return result;
}

function getRoomMaxTimer(room) {
  const state = saleState.get(room);
  return state ? state.maxTimer : 0;
}

// ============================================
// VALIDATION DES MESSAGES
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

  /**
   * Rejoindre une salle
   * Correspond a socket.emit('joinroom', room) dans switcher.php et ventes_live.php
   */
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
      log(`[ADMIN] Admin connecte a la salle ${room}`);
    } else {
      const adminId = getAdminOfRoom(room);
      socket.emit('userList', { admin: adminId });
      log(`[CLIENT] ${socket.id} a rejoint ${room}, admin=${adminId || 'none'}`);

      if (!adminId) {
        socket.emit('waitingForAdmin', { message: 'En attente de l\'administrateur...' });
      }

      // Envoyer le timer restant si disponible
      const remaining = getSaleEndRemaining(room);
      if (remaining !== null) {
        socket.emit('saleEndTimer', {
          room: room,
          remainingSeconds: remaining,
          ended: remaining <= 0
        });
      }
    }
  });

  /**
   * Quitter une salle
   */
  socket.on('leaveroom', (room) => {
    const meta = socketMeta.get(socket.id);
    socket.leave(room);
    if (meta) meta.room = null;
    log(`[leaveroom] ${socket.id} a quitte ${room}`);

    if (meta?.isAdmin) {
      broadcastUserList(io, room);
    }
  });

  /**
   * Synchronisation du timer
   */
  socket.on('saleEndSync', () => {
    const meta = socketMeta.get(socket.id);
    const room = meta?.room;
    const remaining = room ? getSaleEndRemaining(room) : null;

    if (remaining !== null) {
      socket.emit('saleEndTimer', {
        room: room,
        remainingSeconds: remaining,
        ended: remaining <= 0
      });
      log(`[saleEndSync] -> ${socket.id} room=${room} remaining=${remaining}s`);
    } else {
      socket.emit('saleEndTimer', { active: false });
    }
  });

  /**
   * Diffusion d'un message vers toute la salle (getMsgRoom)
   *
   * SEUL L'ADMIN (switcher.php) PEUT ENVOYER:
   *   - numLot (modification du timer)
   *   - listLot (demarrage vente)
   *   - saleEnded (fin de vente)
   *   - previousLot, closeEnchere, updateLot, users
   */
  socket.on('getMsgRoom', (data) => {
    if (!data || !data.room) {
      log(`[ERROR] getMsgRoom sans room`, "ERROR");
      return;
    }

    const meta = socketMeta.get(socket.id);
    const isAdmin = meta?.isAdmin === true;

    // Verification des droits admin
    if (ADMIN_ONLY_TYPES.includes(data.type) && !isAdmin) {
      log(`[SECURITY] REFUSE: ${socket.id} a tente d'envoyer ${data.type} sans droits admin`, "ERROR");
      socket.emit('error', {
        message: 'Non autorise - Seul l\'administrateur peut effectuer cette action',
        type: data.type
      });
      return;
    }

    // Validation des valeurs
    if (!validateMessage(data)) {
      log(`[SECURITY] ${socket.id} valeurs invalides`, "ERROR");
      socket.emit('error', { message: 'Valeurs invalides', type: data.type });
      return;
    }

    let finalMsg = { ...data.msg };
    let extraTimeTriggered = false;
    let newExtraTime = null;

    // TRAITEMENT DE L'EXTRA TIME POUR LES ENCHERES
    if (data.type === 'doEncheres' && !isAdmin && data.msg) {
      const lotNum = data.msg.lot;
      const currentTime = parseInt(data.msg.currentTime) || 0;
      const shouldTrigger = shouldTriggerExtraTime(data.room, lotNum, currentTime);

      if (shouldTrigger) {
        const lotState = getLotState(data.room, lotNum);
        const newTime = calculateExtraTime(currentTime, lotState.extraTimeCount);
        updateLotTime(io, data.room, lotNum, newTime, true);

        finalMsg.extraTimeTriggered = true;
        finalMsg.extraTimeNewTime = newTime;
        finalMsg.extraTimeCount = lotState.extraTimeCount;
        extraTimeTriggered = true;
        newExtraTime = newTime;

        log(`[EXTRA TIME] Enchere sur lot ${lotNum} a declenche Extra Time! Nouveau temps: ${newTime}s`, "SUCCESS");
      }
    }

    // TRAITEMENT DES NUMEROS DE LOT (ADMIN)
    if (data.type === 'numLot' && isAdmin && data.msg) {
      const lotNum = data.msg.numLot;
      const newTime = parseInt(data.msg.time) || 0;
      const isExtraTime = data.msg.extratime === true || data.msg.extratime === "true";
      updateLotTime(io, data.room, lotNum, newTime, isExtraTime);

      log(`[ADMIN] Lot ${lotNum} -> ${newTime}s${isExtraTime ? ' (EXTRA TIME)' : ''}`);
    }

    // INITIALISATION DE LA LISTE DES LOTS
    if (data.type === 'listLot' && data.msg && data.msg.list && isAdmin) {
      for (const lot of data.msg.list) {
        const lotNum = lot.numLot;
        const lotTime = parseInt(lot.time) || 0;
        const isExtraTime = lot.extratime === true || lot.extratime === "true";
        updateLotTime(io, data.room, lotNum, lotTime, isExtraTime);
      }
      const maxTimer = updateRoomMaxTimer(io, data.room);
      log(`[INIT] ${data.msg.list.length} lots initialises - Timer max: ${maxTimer}s`);
    }

    // FIN DE VENTE
    if (data.type === 'saleEnded' && isAdmin) {
      triggerSaleEnd(io, data.room);
      log(`[ADMIN] Fin de vente declenchee pour ${data.room}`);
    }

    // Construction du payload
    const payload = {
      type: data.type || '',
      msg: finalMsg,
      name: data.name || meta?.pseudo || 'unknown',
      from: socket.id,
      isAdmin: isAdmin,
      extraTimeTriggered: extraTimeTriggered,
      extraTimeNewTime: newExtraTime
    };

    log(`[MSG] ${isAdmin ? 'ADMIN' : 'CLIENT'} → room:${data.room} type:${data.type}`);

    // Diffusion à tous les membres de la salle
    io.to(data.room).emit('sendMsg', payload);
  });

  /**
   * Message prive (getMsgPrivate)
   * Utilise par:
   * - Clients pour les encheres (doEncheres)
   * - Admin pour les confirmations (confirmEnchere, validEnchere)
   */
  socket.on('getMsgPrivate', (data) => {
    if (!data || !data.toid) {
      log(`[ERROR] getMsgPrivate sans toid`, "ERROR");
      return;
    }

    const meta = socketMeta.get(socket.id);
    const isAdmin = meta?.isAdmin === true;

    let finalMsg = { ...data.msg };
    let extraTimeTriggered = false;
    let newExtraTime = null;

    // TRAITEMENT DE L'EXTRA TIME POUR LES ENCHERES PRIVEES
    if (data.type === 'doEncheres' && data.msg && !isAdmin) {
      const lotNum = data.msg.lot;
      const room = meta?.room;
      const currentTime = parseInt(data.msg.currentTime) || 0;

      if (room) {
        const shouldTrigger = shouldTriggerExtraTime(room, lotNum, currentTime);

        if (shouldTrigger) {
          const lotState = getLotState(room, lotNum);
          const newTime = calculateExtraTime(currentTime, lotState.extraTimeCount);
          updateLotTime(io, room, lotNum, newTime, true);

          finalMsg.extraTimeTriggered = true;
          finalMsg.extraTimeNewTime = newTime;
          finalMsg.extraTimeCount = lotState.extraTimeCount;
          extraTimeTriggered = true;
          newExtraTime = newTime;

          log(`[EXTRA TIME] Enchere privee sur lot ${lotNum} a declenche Extra Time!`, "SUCCESS");
        }
      }

      log(`[PRIVATE ENCHERE] ${data.name} -> lot ${lotNum} montant: ${data.msg.myEnchere}€`);
    }

    // TRAITEMENT DE LA RECONNECTION
    if (data.type === 'reconnection') {
      log(`[RECONNECTION] Client ${data.name} (${data.msg.email})`);
    }

    // TRAITEMENT DE L'EXIT
    if (data.type === 'exit') {
      log(`[EXIT] Client ${data.name} quitte la vente`);
    }

    // TRAITEMENT DE LA CONFIRMATION D'ENCHERE
    if (data.type === 'confirmEnchere' && data.msg) {
      log(`[CONFIRMATION] Enchere lot ${data.msg.lot} - ${data.msg.state ? 'ACCEPTEE' : 'REFUSEE'}`);
    }

    // TRAITEMENT DE LA VALIDATION D'ENCHERE
    if (data.type === 'validEnchere' && data.msg) {
      log(`[VALIDATION] Lot ${data.msg.lot} remporte par le client`);
    }

    const payload = {
      type: data.type || '',
      msg: finalMsg,
      name: data.name || meta?.pseudo || 'unknown',
      from: socket.id,
      extraTimeTriggered: extraTimeTriggered,
      extraTimeNewTime: newExtraTime
    };

    log(`[PRIVATE] ${socket.id} -> ${data.toid} type:${data.type}`);

    io.to(data.toid).emit('sendMsg', payload);
  });
}

// Export des fonctions pour les autres modules
module.exports = {
  registerRoomHandler,
  getLotState,
  updateLotTime,
  updateRoomMaxTimer,
  triggerSaleEnd,
  resetRoomState,
  getRoomTimers,
  getRoomMaxTimer
};