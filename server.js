const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");

// ─────────────────────────────────────────────
// Initialisation
// ─────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────

const FOLLOW_ROOM = "auctav_follow";

// ─────────────────────────────────────────────
// État en mémoire par room
// ─────────────────────────────────────────────

/**
 * rooms[room] = {
 *   started  : bool,
 *   lots     : { [numLot]: { price, time, status, toid, email, reserveInfo, extratime } },
 *   users    : { [email] : { socketId, name } },
 *   admins   : Set<socketId>
 * }
 */
const rooms = new Map();

function getRoom(room) {
  if (!rooms.has(room)) {
    rooms.set(room, {
      started: false,
      lots: {},
      users: {},
      admins: new Set(),
    });
  }
  return rooms.get(room);
}

function getLotList(state) {
  return Object.entries(state.lots).map(([numLot, lot]) => ({
    numLot,
    ...lot,
  }));
}

// u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500
// Decrement serveur des timers (1x par seconde)
// Garde l'etat serveur synchronise avec le switcher
// pour que les reconnexions recoivent un timer exact
// u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500
setInterval(() => {
  rooms.forEach((state) => {
    if (!state.started) return;
    Object.values(state.lots).forEach((lot) => {
      const t = Number.parseInt(lot.time);
      if (t > 0) lot.time = t - 1;
    });
  });
}, 1000);

// ─────────────────────────────────────────────
// Helpers Follow room
// ─────────────────────────────────────────────

function broadcastFollow(text, style = "") {
  io.to(FOLLOW_ROOM).emit("sendMsg", {
    from: "server",
    name: "Server",
    type: "message",
    msg: { text, style },
  });
}

function broadcastFollowBell() {
  io.to(FOLLOW_ROOM).emit("sendMsg", {
    from: "server",
    name: "Server",
    type: "online",
    msg: {},
  });
}

// ─────────────────────────────────────────────
// Helper log
// ─────────────────────────────────────────────

function log(socketId, event, detail = "") {
  const time = new Date().toLocaleTimeString("fr-FR");
  console.log(`[${time}] [${socketId.slice(0, 6)}] ${event} ${detail}`);
}

// ─────────────────────────────────────────────
// Formatter prix (pour les messages Follow)
// ─────────────────────────────────────────────

const priceFormatter = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

// ─────────────────────────────────────────────
// Socket.io
// ─────────────────────────────────────────────

io.on("connection", (socket) => {
  log(socket.id, "CONNECT");

  let currentRoom = null;
  let isAdmin = false;
  let isFollower = false;

  // ── 1. Identification admin ──────────────────────────────
  // Émis par switcher.php : socket.emit('admin', pseudo)
  socket.on("admin", (pseudo) => {
    isAdmin = true;
    log(socket.id, "ADMIN", `→ ${pseudo}`);
  });

  // ── 2. Rejoindre une room ────────────────────────────────
  // Émis par tous : socket.emit('joinroom', room)
  socket.on("joinroom", (room) => {
    socket.join(room);
    currentRoom = room;

    if (room === FOLLOW_ROOM) {
      isFollower = true;
      log(socket.id, "JOIN_FOLLOW", `→ room "${room}"`);
    } else {
      const state = getRoom(room);
      if (isAdmin) state.admins.add(socket.id);
      log(socket.id, "JOIN", `→ room "${room}"`);
    }
  });

  // ── 3. Messages de l'admin vers la room ─────────────────
  // Émis par switcher.php : socket.emit('getMsgRoom', { room, type, msg, name })
  socket.on("getMsgRoom", ({ room, type, msg, name }) => {
    if (!room || !type) return;

    log(socket.id, "MSG_ROOM", `type="${type}" room="${room}"`);

    // ── Cas spéciaux Follow room ──────────────────────────

    // Relai HTML liste utilisateurs vers Follow
    // switcher.php : sendHTMLFollow() → socket.emit('getMsgRoom', { room:'auctav_follow', type:'users', … })
    if (room === FOLLOW_ROOM && type === "users") {
      io.to(FOLLOW_ROOM).emit("sendMsg", { from: socket.id, name, type: "users", msg });
      return;
    }

    // Message texte explicite de l'admin vers Follow
    // switcher.php : insereMessage/insereMessageSimple → socket.emit('getMsgRoom', { room:'auctav_follow', type:'message', … })
    if (room === FOLLOW_ROOM && type === "message") {
      broadcastFollow(msg.text || "", msg.style || "");
      return;
    }

    // Sonnette manuelle vers Follow
    if (room === FOLLOW_ROOM && type === "online") {
      broadcastFollowBell();
      return;
    }

    // ── Gestion des lots ──────────────────────────────────

    const state = getRoom(room);

    // L'admin démarre le live ou resynchro périodique : liste complète des lots
    // switcher.php : $("#start").click → socket.emit('getMsgRoom', { type:'listLot', … })
    //              : setInterval resynchro → idem
    if (type === "listLot" && msg.list) {
      msg.list.forEach((lot) => {
        state.lots[lot.numLot] = {
          price: lot.price || 0,
          time: lot.time,
          status: lot.statut || "notsold",
          toid: lot.toid || "",
          email: lot.email || "",
          reserveInfo: lot.reserveInfo || 0,
          extratime: lot.extratime || false,
        };
      });

      if (!state.started) {
        state.started = true;
        broadcastFollow(
            `<strong>Vente démarrée</strong> — ${msg.list.length} lot(s) chargés`,
            "ok"
        );
      }
    }

    // L'admin met à jour un lot (soumission formulaire dans switcher.php)
    // switcher.php : $("form").on("submit") → socket.emit('getMsgRoom', { type:'numLot', … })
    if (type === "numLot" && msg.numLot) {
      const lotState = state.lots[msg.numLot];
      if (lotState) {
        const prevTime = Number.parseInt(lotState.time);
        const newTime = Number.parseInt(msg.time);

        lotState.price = msg.price;
        lotState.time = msg.time;
        lotState.status = msg.statut;
        lotState.reserveInfo = msg.reserveInfo;
        lotState.extratime = msg.extratime;

        // Timer vient de tomber à 0 → émettre closeEnchere (attendu par viewer + résultats)
        if (newTime === 0 && prevTime > 0) {
          io.to(room).emit("sendMsg", {
            from: "server",
            name: "Server",
            type: "closeEnchere",
            msg: {
              numLot: msg.numLot,
              price: lotState.price,
              statut: lotState.status,
              toid: lotState.toid ? "online" : "",
            },
          });

          broadcastFollow(
              `<strong>Lot ${msg.numLot}</strong> — Clôturé : ${priceFormatter.format(
                  lotState.price
              )} (${lotState.status})`,
              lotState.toid ? "ok" : "info"
          );
        } else {
          // Mise à jour en cours → updateLot (attendu par la page résultats)
          io.to(room).emit("sendMsg", {
            from: "server",
            name: "Server",
            type: "updateLot",
            msg: {
              numLot: msg.numLot,
              price: lotState.price,
              statut: lotState.status,
              toid: lotState.toid ? "online" : "",
            },
          });
        }
      }
    }

    // Relai brut a toute la room.
    // "numLot" est exclu : deja transforme en closeEnchere ou updateLot ci-dessus.
    // Tous les autres types (listLot, screen, custom...) sont relayes tels quels.
    if (type !== "numLot") {
      io.to(room).emit("sendMsg", { from: socket.id, name, type, msg });
    }
  });

  // ── 4. Messages privés ───────────────────────────────────
  // Utilisé par switcher.php, viewer et clients acheteurs
  socket.on("getMsgPrivate", ({ toid, type, msg, name }) => {
    if (!toid || !type) return;
    log(socket.id, "MSG_PRIVATE", `type="${type}" → ${toid.slice(0, 6)}`);

    // noActivity : l'admin kick un utilisateur (double-clic sur #users ul li)
    if (type === "noActivity") {
      io.to(toid).emit("sendMsg", { from: socket.id, name, type: "noActivity", msg });
      log(socket.id, "KICK", `→ ${toid.slice(0, 6)}`);
      return;
    }

    // validEnchere : l'admin confirme l'adjudicataire quand timer=0 et toid présent
    // switcher.php : socket.emit('getMsgPrivate', { toid, type:'validEnchere', msg:{lot, state:true}, name })
    if (type === "validEnchere") {
      if (currentRoom) {
        const state = getRoom(currentRoom);
        const lotState = state.lots[msg.lot];
        if (lotState) {
          broadcastFollow(
              `<strong>Lot ${msg.lot}</strong> — Adjugé ${priceFormatter.format(
                  lotState.price
              )} ONLINE`,
              "ok"
          );
          broadcastFollowBell();
        }
      }
      io.to(toid).emit("sendMsg", { from: socket.id, name, type, msg });
      return;
    }

    // Tous les autres messages privés :
    // confirmEnchere, listLot, changeDevice, follow, getScreen, noActivity…
    io.to(toid).emit("sendMsg", { from: socket.id, name, type, msg });
  });

  // ── 5. Enchère d'un acheteur ─────────────────────────────
  // Émis par le client acheteur : socket.emit('doEncheres', { room, lot, myEnchere, email, name })
  //
  // IMPORTANT : avec switcher.php en tant qu'admin, c'est l'admin qui valide le prix
  // en soumettant son formulaire après avoir reçu 'doEncheres'. Le serveur vérifie
  // uniquement le timer et le montant minimum, puis transmet à l'admin.
  socket.on("doEncheres", ({ room, lot, myEnchere, email, name }) => {
    const state = getRoom(room);
    const lotState = state.lots[lot];

    log(socket.id, "ENCHERE", `lot=${lot} montant=${myEnchere}€ par ${name}`);

    if (!lotState) {
      socket.emit("sendMsg", {
        from: "server",
        name: "Server",
        type: "confirmEnchere",
        msg: { lot, state: false, reason: "Lot introuvable" },
      });
      return;
    }

    if (Number.parseInt(lotState.time) <= 0) {
      socket.emit("sendMsg", {
        from: "server",
        name: "Server",
        type: "confirmEnchere",
        msg: { lot, state: false, reason: "Enchère clôturée" },
      });
      log(socket.id, "ENCHERE_REFUSEE", `lot=${lot} timer=0`);
      return;
    }

    if (Number.parseInt(myEnchere) <= Number.parseInt(lotState.price)) {
      socket.emit("sendMsg", {
        from: "server",
        name: "Server",
        type: "confirmEnchere",
        msg: {
          lot,
          state: false,
          reason: `Montant insuffisant (actuelle: ${lotState.price}€)`,
        },
      });
      log(socket.id, "ENCHERE_REFUSEE", `lot=${lot} ${myEnchere}€ <= ${lotState.price}€`);
      return;
    }
    // Pre-valide : transmettre a l'admin qui decidera via le formulaire switcher.php
    state.admins.forEach((adminId) => {
      io.to(adminId).emit("sendMsg", {
        from: socket.id,
        name,
        type: "doEncheres",
        msg: { lot, myEnchere, email },
      });
    });

    // Notifier les écrans Follow
    broadcastFollow(
        `<strong>Lot ${lot}</strong> — Enchère ONLINE reçue : ${priceFormatter.format(
            myEnchere
        )} par <em>${name}</em>`,
        "online"
    );

    log(socket.id, "ENCHERE_TRANSMISE", `lot=${lot} ${myEnchere}€ par ${name} → admin`);
  });

  // ── 6. Connexion d'un acheteur ───────────────────────────
  // Émis par le client : socket.emit('connected', { room, email, name })
  socket.on("connected", ({ room, email, name }) => {
    const state = getRoom(room);
    state.users[email] = { socketId: socket.id, name };

    log(socket.id, "CLIENT_CONNECTED", `${name} (${email})`);

    // Notifie les admins (switcher.php écoute 'connected' → addUserList)
    state.admins.forEach((adminId) => {
      io.to(adminId).emit("sendMsg", {
        from: socket.id,
        name,
        type: "connected",
        msg: { room, email },
      });
    });

    broadcastFollow(
        `<span>Connexion : <strong>${name}</strong> (${email})</span>`,
        "connected"
    );

    if (state.started) {
      socket.emit("sendMsg", {
        from: "server",
        name: "Server",
        type: "listLot",
        msg: { list: getLotList(state) },
      });
    }
  });

  // ── 7. Reconnexion d'un acheteur ────────────────────────
  // Émis par le client : socket.emit('reconnection', { room, email, name })
  // switcher.php gère le changeDevice et renvoie listLot via getMsgPrivate
  socket.on("reconnection", ({ room, email, name }) => {
    const state = getRoom(room);
    const oldSocketId = state.users[email]?.socketId;
    state.users[email] = { socketId: socket.id, name };

    log(socket.id, "CLIENT_RECONNECTED", `${name} (${email})`);

    // Met à jour le toid dans les lots si cet email avait la meilleure enchère
    Object.values(state.lots).forEach((lot) => {
      if (lot.email === email) lot.toid = socket.id;
    });

    // Notifie les admins (switcher.php gère changeDevice + envoie listLot)
    state.admins.forEach((adminId) => {
      io.to(adminId).emit("sendMsg", {
        from: socket.id,
        name,
        type: "reconnection",
        msg: { room, email },
      });
    });

    broadcastFollow(
        `<span>Reconnexion : <strong>${name}</strong> (${email})</span>`,
        "connected"
    );

    // Fallback sans admin : le serveur gère seul changeDevice + listLot
    if (state.admins.size === 0 && state.started) {
      if (oldSocketId && oldSocketId !== socket.id) {
        io.to(oldSocketId).emit("sendMsg", {
          from: "server",
          name: "Server",
          type: "changeDevice",
          msg: { manuel: true },
        });
      }
      socket.emit("sendMsg", {
        from: "server",
        name: "Server",
        type: "listLot",
        msg: { list: getLotList(state) },
      });
    }
  });

  // ── 8. Demande de liste de lots (ancienne API) ───────────
  // Certains vieux clients émettent 'getEncheresList'
  // switcher.php écoute ce type et répond avec listLot via getMsgPrivate
  socket.on("getEncheresList", ({ room, email, name } = {}) => {
    if (!room) return;
    const state = getRoom(room);
    log(socket.id, "GET_ENCHERES_LIST", `room="${room}"`);

    state.admins.forEach((adminId) => {
      io.to(adminId).emit("sendMsg", {
        from: socket.id,
        name: name || "",
        type: "getEncheresList",
        msg: { room, email },
      });
    });

    // Fallback sans admin
    if (state.admins.size === 0 && state.started) {
      socket.emit("sendMsg", {
        from: "server",
        name: "Server",
        type: "listLot",
        msg: { list: getLotList(state) },
      });
    }
  });

  // ── 9. Ping follow ───────────────────────────────────────
  // Réponse automatique au serveur (switcher.php gère aussi ce cas côté admin)
  socket.on("follow", () => {
    socket.emit("sendMsg", {
      from: "server",
      name: "Server",
      type: "follow",
      msg: { statut: true },
    });
  });

  // ── 10. Déconnexion ──────────────────────────────────────
  socket.on("disconnect", (reason) => {
    if (currentRoom && !isFollower) {
      const state = getRoom(currentRoom);
      state.admins.delete(socket.id);

      const entry = Object.entries(state.users).find(
          ([, u]) => u.socketId === socket.id
      );
      if (entry) {
        const [email, user] = entry;
        state.admins.forEach((adminId) => {
          io.to(adminId).emit("sendMsg", {
            from: socket.id,
            name: user.name,
            type: "exit",
            msg: { room: currentRoom, email },
          });
        });

        broadcastFollow(
            `<span>Déconnexion : <strong>${user.name}</strong> (${email})</span>`,
            "info"
        );
      }
    }
    log(socket.id, "DISCONNECT", `→ ${reason}`);
  });
});

// ─────────────────────────────────────────────
// Route de santé
// ─────────────────────────────────────────────

app.get("/health", (req, res) => {
  const roomsInfo = [...rooms.entries()].map(([name, state]) => ({
    name,
    started: state.started,
    lots: Object.keys(state.lots).length,
    users: Object.keys(state.users).length,
    admins: state.admins.size,
  }));
  res.json({
    status: "ok",
    connectedSockets: io.engine.clientsCount,
    rooms: roomsInfo,
  });
});

app.get("/", (req, res) => res.send("Serveur auction OK"));

// ─────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n Auction Socket Server démarré sur le port ${PORT}`);
  console.log(`   → http://localhost:${PORT}/health\n`);
});