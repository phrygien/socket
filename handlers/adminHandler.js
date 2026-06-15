// ─── Admin Handler ────────────────────────────────────────────────────────────
// Événements émis par switcher.php

const socketMeta               = require('../store');
const { log }                  = require('../utils/logger');
const { broadcastUserList }    = require('../services/roomService');

function registerAdminHandler(io, socket) {
  /**
   * Identification de l'admin — émis avant joinroom.
   * socket.emit('admin', pseudo)
   */
  socket.on('admin', (pseudo) => {
    const meta = socketMeta.get(socket.id);
    if (meta) {
      meta.pseudo  = pseudo || 'Admin';
      meta.isAdmin = true;
    }
    log(`  [admin]    : ${socket.id} → "${pseudo}"`);

    // Si l'admin était déjà dans une salle (reconnexion rapide), notifier
    if (meta?.room) broadcastUserList(io, meta.room);
  });

  socket.on('admin:kick', ({ socketId }) => {
    // Vérifier que c'est bien un admin qui demande
    const meta = socketMeta.get(socket.id);
    if (!meta?.isAdmin) return;

    const target = io.sockets.sockets.get(socketId);
    if (target) {
      target.emit('kicked');   // prévient le client
      target.disconnect(true); // déconnecte
      log(`[ADMIN KICK] ${socketId} éjecté par ${socket.id}`);
    }
  });
}

module.exports = { registerAdminHandler };
