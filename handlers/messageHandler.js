// ─── Message Handler ──────────────────────────────────────────────────────────

const socketMeta = require('../store');
const { log }    = require('../utils/logger');

function registerMessageHandler(io, socket) {
  /**
   * Message privé ciblé vers un socket précis.
   * data = { toid, type, msg, name }
   * Types : confirmEnchere | validEnchere | listLot | follow |
   *         changeDevice   | noActivity   | reconnection
   */
  socket.on('getMsgPrivate', (data) => {
    if (!data || !data.toid) return;

    const payload = {
      type : data.type || '',
      msg  : data.msg  || {},
      name : data.name || socketMeta.get(socket.id)?.pseudo || 'unknown',
      from : socket.id
    };

    log(`  [private→${data.toid}] type="${data.type}" from=${socket.id}`);

    io.to(data.toid).emit('sendMsg', payload);
  });
}

module.exports = { registerMessageHandler };
