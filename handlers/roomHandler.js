// ─── Room Handler ─────────────────────────────────────────────────────────────
// Gestion des salles et diffusion des messages
// Compatible avec switcher.php (Admin) et ventes_live.php (Clients)

const socketMeta                            = require('../store');
const { log }                               = require('../utils/logger');
const { getAdminOfRoom, broadcastUserList } = require('../services/roomService');
const {
  updateSaleEndTimer,
  clearSaleEndTimer,
  getSaleEndRemaining
} = require('../services/saleEndService');

// ============================================
// CONFIGURATION
// ============================================
const MAX_TIME            = 3600;
const MAX_PRICE           = 10000000;
const MIN_PRICE           = 0;
const MIN_LOT             = 1;
const MAX_LOT             = 999;
const EXTRA_TIME_DURATION = 30;
const MAX_EXTRA_TIME      = 300;

// ============================================
// STOCKAGE D'ÉTAT DES SALLES
// ============================================
const saleState = new Map();

function getRoomState(room) {
  if (!saleState.has(room)) {
    saleState.set(room, {
      lots         : new Map(),
      ended        : false,
      saleEnded    : false,
      maxTimer     : 0,
      lastActivity : Date.now()
    });
  }
  return saleState.get(room);
}

function getLotState(room, lotNum) {
  const state = getRoomState(room);
  if (!state.lots.has(lotNum)) {
    state.lots.set(lotNum, {
      currentTime     : 0,
      extraTimeCount  : 0,
      lastExtraTimeAt : 0,
      isActive        : false,
      extratime       : false,
      closed          : false
    });
  }
  return state.lots.get(lotNum);
}

// ============================================
// TIMERS ET ÉTAT DES LOTS
// ============================================

function updateLotTime(io, room, lotNum, newTime, isExtraTime = false) {
  const lotState = getLotState(room, lotNum);
  const oldTime  = lotState.currentTime;

  lotState.currentTime = newTime;
  lotState.extratime   = isExtraTime;
  lotState.isActive    = newTime > 0;

  if (isExtraTime) {
    lotState.extraTimeCount++;
    lotState.lastExtraTimeAt = Date.now();
  }

  updateRoomMaxTimer(io, room);

  log(`[LOT] Room ${room} Lot ${lotNum}: ${oldTime}s -> ${newTime}s${isExtraTime ? ' (EXTRA TIME)' : ''}`);
  return lotState;
}

function updateRoomMaxTimer(io, room) {
  const state = getRoomState(room);

  if (state.saleEnded || state.ended) return 0;

  let maxTimer = 0;
  for (const [, lotState] of state.lots) {
    if (!lotState.closed && lotState.currentTime > maxTimer) {
      maxTimer = lotState.currentTime;
    }
  }

  state.maxTimer     = maxTimer;
  state.lastActivity = Date.now();

  log(`[TIMER MAX] Room ${room}: ${maxTimer}s`);

  if (maxTimer > 0) {
    updateSaleEndTimer(io, room, maxTimer);
  } else if (!state.ended && !state.saleEnded) {
    log(`[SALE] Condition de fin de vente atteinte pour ${room}`, 'SALE');
    triggerSaleEnd(io, room);
  }

  return maxTimer;
}

function shouldTriggerExtraTime(room, lotNum, currentTime) {
  if (currentTime > 1 || currentTime <= 0) return false;

  const state = getRoomState(room);
  if (state.ended || state.saleEnded) return false;

  const lotState = getLotState(room, lotNum);
  return !lotState.closed;
}

function calculateExtraTime(currentTime, extraTimeCount) {
  return Math.min(currentTime + EXTRA_TIME_DURATION, MAX_EXTRA_TIME);
}

// ============================================
// FIN DE VENTE
// ============================================

/**
 * Ferme tous les lots côté serveur et notifie la room
 * (appelé depuis la gestion de 'saleEnded' dans getMsgRoom)
 */
function closeAllLots(io, room) {
  const state = getRoomState(room);

  log(`[CLOSE] Fermeture de tous les lots dans la salle ${room}`, 'SALE');

  for (const [lotNum, lotState] of state.lots) {
    lotState.currentTime = 0;
    lotState.isActive    = false;
    lotState.closed      = true;

    // Notifier chaque lot individuellement pour que les clients
    // (et l'admin) puissent mettre à jour leur UI lot par lot
    io.to(room).emit('sendMsg', {
      type : 'numLot',
      msg  : {
        numLot   : lotNum,
        price    : 0,
        time     : 0,
        extratime: false,
        statut   : 'sold',
        closed   : true
      },
      name : 'System',
      from : 'system'
    });
  }

  state.maxTimer  = 0;
  state.ended     = true;
  state.saleEnded = true;

  clearSaleEndTimer(room);
}

/**
 * Émet le signal de fin de vente à toute la room
 * (appelé après closeAllLots ou quand tous les timers tombent à 0)
 */
function triggerSaleEnd(io, room) {
  const state = getRoomState(room);
  if (state.ended || state.saleEnded) return;

  state.ended     = true;
  state.saleEnded = true;
  clearSaleEndTimer(room);

  io.to(room).emit('sendMsg', {
    type : 'saleEnded',
    msg  : {
      message      : 'La vente est terminee',
      timestamp    : Date.now(),
      redirectUrl  : '/resultats.php',
      allLotsClosed: true
    },
    name : 'System',
    from : 'system'
  });

  log(`[SALE] FIN DE VENTE — Salle ${room}`, 'SALE');
}

function isSaleEnded(room) {
  if (!saleState.has(room)) return false;
  const state = saleState.get(room);
  return state.ended || state.saleEnded;
}

// ============================================
// VALIDATION
// ============================================

// Types réservés à l'admin — un client ne peut pas les émettre
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
        log(`[VALIDATION] Timer invalide: ${time}`, 'ERROR');
        return false;
      }
    }
    if (data.msg.price !== undefined) {
      const price = parseInt(data.msg.price);
      if (isNaN(price) || price < MIN_PRICE || price > MAX_PRICE) {
        log(`[VALIDATION] Prix invalide: ${price}`, 'ERROR');
        return false;
      }
    }
    if (data.msg.numLot !== undefined) {
      const lotNum = parseInt(data.msg.numLot);
      if (isNaN(lotNum) || lotNum < MIN_LOT || lotNum > MAX_LOT) {
        log(`[VALIDATION] Lot invalide: ${lotNum}`, 'ERROR');
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

  // ── Rejoindre une salle ──────────────────────────────────────────────────────
  // room = "auctav<saleId>"  ex: "auctav42"
  socket.on('joinroom', (room) => {
    const meta    = socketMeta.get(socket.id);
    const isAdmin = meta?.isAdmin === true;

    // Quitter l'ancienne salle si nécessaire
    if (meta?.room) {
      const oldRoom = meta.room;
      socket.leave(oldRoom);
      if (meta.isAdmin) broadcastUserList(io, oldRoom);
    }

    socket.join(room);
    if (meta) meta.room = room;

    log(`[joinroom] ${socket.id} → ${room} (admin=${isAdmin})`);

    if (isAdmin) {
      broadcastUserList(io, room);
      socket.emit('adminJoined', { room, status: 'ok' });
    } else {
      // Envoyer l'admin actuel au nouveau bidder
      const adminId = getAdminOfRoom(room);
      socket.emit('userList', { admin: adminId });
      log(`[userList→${socket.id}] admin=${adminId || 'none'}`);

      // Si la vente est déjà terminée, le notifier immédiatement
      if (isSaleEnded(room)) {
        socket.emit('sendMsg', {
          type : 'saleEnded',
          msg  : {
            message    : 'La vente est terminee',
            redirectUrl: '/resultats.php',
            allLotsClosed: true
          },
          name : 'System',
          from : 'system'
        });
      } else {
        // Envoyer le temps restant global si disponible
        const remaining = getSaleEndRemaining(room);
        if (remaining !== null) {
          socket.emit('saleEndTimer', {
            room,
            remainingSeconds: remaining,
            ended: remaining <= 0
          });
        }
      }
    }
  });

  // ── Quitter une salle ────────────────────────────────────────────────────────
  socket.on('leaveroom', (room) => {
    const meta = socketMeta.get(socket.id);
    socket.leave(room);
    if (meta) meta.room = null;
    if (meta?.isAdmin) broadcastUserList(io, room);
  });

  // ── Synchronisation état de la vente (client qui se reconnecte) ──────────────
  socket.on('saleEndSync', () => {
    const meta = socketMeta.get(socket.id);
    const room = meta?.room;
    if (!room) return;

    if (isSaleEnded(room)) {
      socket.emit('sendMsg', {
        type : 'saleEnded',
        msg  : {
          message      : 'La vente est terminee',
          redirectUrl  : '/resultats.php',
          allLotsClosed: true
        },
        name : 'System',
        from : 'system'
      });
    } else {
      const remaining = getSaleEndRemaining(room);
      socket.emit('saleEndTimer', remaining !== null
          ? { room, remainingSeconds: remaining, ended: remaining <= 0 }
          : { active: false }
      );
    }
  });

  // ── Diffusion vers toute la salle ────────────────────────────────────────────
  // Types émis par l'admin (switcher.php) :
  //   listLot      → initialisation de la liste des lots
  //   numLot       → état courant d'un lot (prix, temps, statut)
  //   previousLot  → lot précédent adjugé (→ screen.php)
  //   saleEnded    → fin de vente manuelle (admin) — déclenche closeAllLots
  //   message      → message texte libre (→ follow.php)
  //   users        → liste HTML des bidders (→ follow.php)
  //   closeEnchere → clôture d'une enchère (→ results.php)
  //   updateLot    → mise à jour d'un lot (→ results.php)
  socket.on('getMsgRoom', (data) => {
    if (!data || !data.room) {
      log('[ERROR] getMsgRoom sans room', 'ERROR');
      return;
    }

    const meta    = socketMeta.get(socket.id);
    const isAdmin = meta?.isAdmin === true;

    // Bloquer les types admin si l'émetteur n'est pas admin
    if (ADMIN_ONLY_TYPES.includes(data.type) && !isAdmin) {
      log(`[SECURITY] REFUSE: ${socket.id} a tenté d'envoyer "${data.type}" sans droits admin`, 'ERROR');
      socket.emit('error', { message: 'Non autorisé', type: data.type });
      return;
    }

    if (!validateMessage(data)) {
      socket.emit('error', { message: 'Valeurs invalides', type: data.type });
      return;
    }

    let finalMsg = { ...data.msg };

    // ── listLot : initialisation des lots côté serveur ──────────────────────
    if (data.type === 'listLot' && isAdmin && Array.isArray(data.msg?.list)) {
      const roomState = getRoomState(data.room);

      // Réinitialiser l'état de fin si l'admin relance la vente
      if (roomState.saleEnded || roomState.ended) {
        log(`[RESTART] Relancement de la vente dans la salle ${data.room}`, 'SALE');
        roomState.ended     = false;
        roomState.saleEnded = false;
        roomState.lots.clear();
      }

      for (const lot of data.msg.list) {
        const lotNum      = lot.numLot;
        const lotTime     = parseInt(lot.time) || 0;
        const isExtraTime = lot.extratime === true || lot.extratime === 'true';
        const lotState    = getLotState(data.room, lotNum);
        lotState.currentTime = lotTime;
        lotState.extratime   = isExtraTime;
        lotState.isActive    = lotTime > 0;
        lotState.closed      = false;
      }

      updateRoomMaxTimer(io, data.room);
      log(`[INIT] ${data.msg.list.length} lots initialisés dans la salle ${data.room}`);
    }

    // ── numLot : mise à jour d'un lot par l'admin ────────────────────────────
    if (data.type === 'numLot' && isAdmin && data.msg) {
      const lotNum      = data.msg.numLot;
      const newTime     = parseInt(data.msg.time) || 0;
      const isExtraTime = data.msg.extratime === true || data.msg.extratime === 'true';
      const lotState    = getLotState(data.room, lotNum);

      lotState.currentTime = newTime;
      lotState.extratime   = isExtraTime;
      lotState.isActive    = newTime > 0;
      if (isExtraTime) lotState.extraTimeCount++;

      updateRoomMaxTimer(io, data.room);

      finalMsg.extratime      = isExtraTime;
      finalMsg.extraTimeCount = lotState.extraTimeCount;
    }

    // ── saleEnded : fin de vente manuelle déclenchée par l'admin ────────────
    // On ferme tous les lots, puis on laisse io.to(room).emit ci-dessous
    // broadcaster le saleEnded final à toute la room (admin + clients).
    if (data.type === 'saleEnded' && isAdmin) {
      log('[ADMIN] Fin de vente manuelle — fermeture de tous les lots', 'SALE');
      closeAllLots(io, data.room);
      // triggerSaleEnd est appelé dans closeAllLots → il a déjà broadcasté saleEnded.
      // On sort ici pour ne pas émettre un second saleEnded en doublon.
      return;
    }

    // ── Diffusion générale ───────────────────────────────────────────────────
    const payload = {
      type  : data.type || '',
      msg   : finalMsg,
      name  : data.name || meta?.pseudo || 'unknown',
      from  : socket.id,
      isAdmin
    };

    log(`[room→${data.room}] type="${data.type}" from=${socket.id}`);

    // Diffuse à TOUS les membres de la salle, y compris l'émetteur
    io.to(data.room).emit('sendMsg', payload);
  });

  // ── Message privé (bidder ↔ admin) ──────────────────────────────────────────
  // Types émis par les bidders :
  //   doEncheres      → tentative d'enchère { lot, myEnchere, email, currentTime, triggerExtraTime }
  //   getEncheresList → demande la liste des lots à l'admin
  //   reconnection    → reconnexion d'un bidder déjà connu
  //   follow          → réponse au ping de présence
  //
  // Types émis par l'admin :
  //   confirmEnchere  → validation ou refus d'une enchère { lot, state }
  //   validEnchere    → adjudication finale { lot, state }
  //   listLot         → liste des lots (réponse à getEncheresList / reconnection)
  //   changeDevice    → signale à l'ancien socket de se déconnecter
  //   noActivity      → kick d'un bidder
  socket.on('getMsgPrivate', (data) => {
    if (!data || !data.toid) {
      log('[ERROR] getMsgPrivate sans toid', 'ERROR');
      return;
    }

    const meta    = socketMeta.get(socket.id);
    const isAdmin = meta?.isAdmin === true;
    const room    = meta?.room;

    // ── Vérifier la vente avant de traiter une enchère ───────────────────────
    if (data.type === 'doEncheres' && !isAdmin) {
      if (room && isSaleEnded(room)) {
        log(`[BLOCKED] Enchère refusée — vente terminée pour ${data.name}`, 'WARNING');
        socket.emit('sendMsg', {
          type : 'confirmEnchere',
          msg  : { lot: data.msg?.lot, state: false, reason: 'Vente terminee' },
          name : 'System',
          from : 'system'
        });
        return;
      }
    }

    let finalMsg = { ...data.msg };

    // ── Extra Time : déclenché par le bidder si le temps est critique ────────
    if (data.type === 'doEncheres' && !isAdmin && data.msg) {
      const lotNum              = data.msg.lot;
      const currentTime         = parseInt(data.msg.currentTime) || 0;
      const clientRequestExtra  = data.msg.triggerExtraTime === true;

      if (room && clientRequestExtra && shouldTriggerExtraTime(room, lotNum, currentTime)) {
        const lotState = getLotState(room, lotNum);
        const newTime  = calculateExtraTime(currentTime, lotState.extraTimeCount);
        updateLotTime(io, room, lotNum, newTime, true);

        finalMsg.extraTimeTriggered = true;
        finalMsg.extraTimeNewTime   = newTime;
        finalMsg.extratime          = true;

        log(`[EXTRA TIME] Lot ${lotNum} → Extra Time déclenché !`, 'SUCCESS');
      }

      log(`[PRIVATE ENCHERE] ${data.name} → lot ${lotNum} montant: ${data.msg.myEnchere}€`);
    }

    const payload = {
      type : data.type || '',
      msg  : finalMsg,
      name : data.name || meta?.pseudo || 'unknown',
      from : socket.id
    };

    log(`[private→${data.toid}] type="${data.type}" from=${socket.id}`);

    io.to(data.toid).emit('sendMsg', payload);
  });
}

module.exports = {
  registerRoomHandler,
  isSaleEnded,
  closeAllLots,
  triggerSaleEnd
};