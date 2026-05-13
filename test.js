const { io } = require("socket.io-client");

const URL = "https://dev.astucom.com:9022";
const ROOM = "auctav-test-250";

const ADMIN = "Admin-Test";
const CLIENTS = 250;

console.log("🚀 Test démarrage : 1 admin +", CLIENTS, "clients");

// --------------------
// ADMIN
// --------------------
const adminSocket = io(URL, {
    transports: ["websocket"],
    reconnection: false
});

adminSocket.on("connect", () => {
    console.log("✔ Admin connecté :", adminSocket.id);

    adminSocket.emit("admin", ADMIN);
    adminSocket.emit("joinroom", ROOM);

    // après connexion admin -> envoi listLot
    setTimeout(() => {
        const list = [];

        for (let i = 1; i <= 10; i++) {
            list.push({
                numLot: i,
                price: 100 * i,
                time: 30 + i
            });
        }

        console.log("📦 Admin envoie listLot");

        adminSocket.emit("getMsgRoom", {
            room: ROOM,
            type: "listLot",
            msg: { list },
            name: ADMIN
        });

    }, 2000);
});

// --------------------
// CLIENTS
// --------------------
let clients = [];

for (let i = 0; i < CLIENTS; i++) {

    const socket = io(URL, {
        transports: ["websocket"],
        reconnection: false
    });

    socket.on("connect", () => {
        console.log(`✔ Client ${i} connecté`);

        socket.emit("joinroom", ROOM);
    });

    socket.on("sendMsg", (data) => {
        if (data.type === "listLot") {
            console.log(`📥 Client ${i} a reçu listLot (${data.msg.list.length} lots)`);
        }
    });

    socket.on("connect_error", (err) => {
        console.log(`❌ Client ${i} erreur :`, err.message);
    });

    clients.push(socket);
}