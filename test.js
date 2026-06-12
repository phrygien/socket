const { io } = require("socket.io-client");

const URL = "http://localhost:3005/";
const ROOM = "auctav-test-complete";

const ADMIN = "Admin-Test";
const CLIENTS = 5;
const TOTAL_LOTS = 10;

console.log("=".repeat(70));
console.log("TEST COMPLET SOCKET.IO - TOUS LES EVENEMENTS");
console.log("=".repeat(70));
console.log(`URL: ${URL}`);
console.log(`Room: ${ROOM}`);
console.log(`Admin: ${ADMIN}`);
console.log(`Clients: ${CLIENTS}`);
console.log(`Lots: ${TOTAL_LOTS}`);
console.log("=".repeat(70));
console.log("");

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    miniPrice: 2000,
    baseTime: 60,
    incrementPerLot: 5,
    extraTimeThreshold: 60,
    extraTimeDuration: 59,
    maxTime: 3600
};

// ============================================
// STATISTIQUES
// ============================================
const metrics = {
    startTime: Date.now(),

    // Messages
    adminMessages: 0,
    clientMessages: 0,
    hackerMessages: 0,

    // Événements
    listLotReceived: 0,
    numLotReceived: 0,
    saleEndedReceived: 0,
    messageReceived: 0,
    followReceived: 0,

    // Enchères
    bidsReceived: 0,
    bidsValidated: 0,
    bidsRejected: 0,
    bidsAfterEnd: 0,

    // Extra Time
    extraTimeTriggered: 0,
    extraTimeDetected: 0,

    // Sécurité
    unauthorizedAttempts: 0,
    invalidTimerAttempts: 0,
    duplicateMessages: 0,

    // Connexions
    connectionErrors: 0,
    clientsConnected: 0,

    // Stockage
    timings: [],
    extraTimeEvents: []
};

// ============================================
// FONCTIONS UTILITAIRES
// ============================================
function getTimestamp() {
    return new Date().toLocaleTimeString();
}

function getPrice(price) {
    return new Intl.NumberFormat('fr-FR', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 0
    }).format(price);
}

function log(message, type = "INFO") {
    const icons = {
        "INFO": "📘", "ADMIN": "👑", "CLIENT": "👤",
        "HACKER": "💀", "SUCCESS": "✅", "ERROR": "❌",
        "WARNING": "⚠️", "TEST": "🔧", "SALE": "🏁",
        "BID": "💰", "EXTRA": "⚡", "CONNECT": "🔌"
    };
    console.log(`${icons[type] || "📘"} [${getTimestamp()}] ${message}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// GENERATION DES LOTS
// ============================================
function generateLots() {
    const lots = [];
    let totalTime = 0;

    for (let i = 1; i <= TOTAL_LOTS; i++) {
        const time = CONFIG.baseTime + ((i - 1) * CONFIG.incrementPerLot);
        const price = 1000 * i;
        totalTime += time;

        lots.push({
            numLot: i,
            price: price,
            time: time,
            initialTime: time,
            extratime: false,
            statut: "",
            reserveInfo: 0,
            toid: null
        });
    }

    log(`${TOTAL_LOTS} lots generes - Temps total: ${Math.floor(totalTime / 60)}m ${totalTime % 60}s`, "SUCCESS");
    return lots;
}

let lots = generateLots();

// ============================================
// ADMIN SOCKET (switcher.php)
// ============================================
log("Creation du socket Admin...", "ADMIN");
const adminSocket = io(URL, {
    transports: ["websocket"],
    reconnection: false
});

let saleStarted = false;
let saleActive = true;
let currentLotIndex = 0;

adminSocket.on("connect", () => {
    log(`Connecte - ID: ${adminSocket.id}`, "ADMIN");
    adminSocket.emit("admin", ADMIN);
    adminSocket.emit("joinroom", ROOM);
});

adminSocket.on("connect_error", (err) => {
    log(`Erreur connexion: ${err.message}`, "ERROR");
    metrics.connectionErrors++;
});

adminSocket.on("error", (data) => {
    log(`Erreur: ${JSON.stringify(data)}`, "ERROR");
});

// Écouter les réponses du serveur
adminSocket.on("sendMsg", (data) => {
    if (data.type === "saleEnded") {
        log(`[SERVEUR] Fin de vente recue`, "SALE");
        metrics.saleEndedReceived++;
    }
    if (data.type === "confirmEnchere") {
        log(`[SERVEUR] Confirmation enchere lot ${data.msg.lot}: ${data.msg.state ? "ACCEPTEE" : "REFUSEE"}`, data.msg.state ? "SUCCESS" : "WARNING");
    }
});

// Fonctions admin
function sendListLot() {
    const listData = lots.map(lot => ({
        numLot: lot.numLot,
        price: lot.price,
        time: lot.time,
        extratime: lot.extratime,
        statut: lot.statut,
        reserveInfo: lot.reserveInfo
    }));

    log(`Envoi listLot (${TOTAL_LOTS} lots)`, "ADMIN");
    adminSocket.emit("getMsgRoom", {
        room: ROOM,
        type: "listLot",
        msg: { list: listData, totalLots: TOTAL_LOTS },
        name: ADMIN
    });
    metrics.adminMessages++;
}

function sendNumLot(lotNum, time, price, extraTime = false, statut = "") {
    log(`Envoi numLot ${lotNum} - time:${time}s - price:${price}€${extraTime ? ' (EXTRA TIME)' : ''}`, "ADMIN");
    adminSocket.emit("getMsgRoom", {
        room: ROOM,
        type: "numLot",
        msg: {
            numLot: lotNum,
            price: price,
            time: time,
            extratime: extraTime,
            statut: statut,
            reserveInfo: extraTime ? 1 : 0
        },
        name: ADMIN
    });
    metrics.adminMessages++;
}

function sendMessage(text) {
    log(`Message public: "${text}"`, "ADMIN");
    adminSocket.emit("getMsgRoom", {
        room: ROOM,
        type: "message",
        msg: { text: text },
        name: ADMIN
    });
    metrics.adminMessages++;
}

function sendSaleEnded() {
    log("Envoi fin de vente", "ADMIN");
    adminSocket.emit("getMsgRoom", {
        room: ROOM,
        type: "saleEnded",
        msg: {
            message: "Vente terminee",
            redirectUrl: "/resultats.php",
            totalLots: TOTAL_LOTS
        },
        name: ADMIN
    });
    metrics.adminMessages++;
}

function validateBid(lotNum, bidAmount, bidderId, isExtraTime = false) {
    log(`Validation enchere lot ${lotNum} - ${bidAmount}€${isExtraTime ? ' + EXTRA TIME' : ''}`, "ADMIN");
    adminSocket.emit("getMsgRoom", {
        room: ROOM,
        type: "numLot",
        msg: {
            numLot: lotNum,
            price: bidAmount,
            time: isExtraTime ? 30 : 0,
            extratime: isExtraTime,
            statut: isExtraTime ? "" : "sold",
            reserveInfo: 3,
            toid: bidderId
        },
        name: ADMIN
    });
    metrics.adminMessages++;
    if (!isExtraTime) metrics.bidsValidated++;
}

// ============================================
// CLIENT SIMULATEUR (ventes_live.php)
// ============================================
class AuctionClient {
    constructor(id, name, email) {
        this.id = id;
        this.name = name;
        this.email = email;
        this.socket = io(URL, { transports: ["websocket"], reconnection: false });
        this.currentBids = {};
        this.receivedMessages = [];
        this.saleEnded = false;
        this.setupListeners();
    }

    setupListeners() {
        this.socket.on("connect", () => {
            log(`${this.name} connecte`, "CLIENT");
            metrics.clientsConnected++;
            this.socket.emit("joinroom", ROOM);
            this.socket.emit("username", this.name);
        });

        this.socket.on("sendMsg", (data) => {
            metrics.clientMessages++;

            // Comptage par type
            if (data.type === "listLot") {
                metrics.listLotReceived++;
                log(`${this.name} a recu listLot (${data.msg.list?.length || 0} lots)`, "CLIENT");
            }
            if (data.type === "numLot") {
                metrics.numLotReceived++;
                const timeLeft = data.msg.time;
                log(`${this.name} - Lot ${data.msg.numLot} - Temps: ${timeLeft}s - Prix: ${getPrice(data.msg.price)}`, "CLIENT");

                // Détection extra time
                if (data.msg.extratime === true) {
                    metrics.extraTimeDetected++;
                    log(`${this.name} - EXTRA TIME detecte sur lot ${data.msg.numLot}!`, "EXTRA");
                    metrics.extraTimeEvents.push({
                        lot: data.msg.numLot,
                        time: timeLeft,
                        timestamp: Date.now()
                    });
                }

                // Vérifier timer invalide
                if (timeLeft > CONFIG.maxTime) {
                    metrics.invalidTimerAttempts++;
                    log(`${this.name} - Timer invalide recu: ${timeLeft}s`, "WARNING");
                }
            }
            if (data.type === "message") {
                metrics.messageReceived++;
                log(`${this.name} - Message: "${data.msg.text}"`, "CLIENT");
            }
            if (data.type === "follow") {
                metrics.followReceived++;
            }
            if (data.type === "saleEnded") {
                metrics.saleEndedReceived++;
                this.saleEnded = true;
                log(`${this.name} - VENTE TERMINEE`, "SALE");
            }
            if (data.type === "confirmEnchere") {
                if (data.msg.state) {
                    log(`${this.name} - Enchere ACCEPTEE lot ${data.msg.lot}`, "SUCCESS");
                } else {
                    log(`${this.name} - Enchere REFUSEE lot ${data.msg.lot}`, "WARNING");
                    metrics.bidsRejected++;
                }
            }
            if (data.type === "validEnchere") {
                log(`${this.name} - ✔ Lot ${data.msg.lot} REMPORTE!`, "SUCCESS");
            }
            if (data.type === "userList") {
                log(`${this.name} - Admin connecte: ${data.admin || 'aucun'}`, "CLIENT");
            }
        });

        this.socket.on("userList", (data) => {
            log(`${this.name} - UserList: admin=${data.admin}`, "CLIENT");
        });

        this.socket.on("adminJoined", (data) => {
            log(`${this.name} - Admin a rejoint la salle`, "CLIENT");
        });

        this.socket.on("waitingForAdmin", (data) => {
            log(`${this.name} - ${data.message}`, "CLIENT");
        });

        this.socket.on("connect_error", (err) => {
            log(`${this.name} - Erreur: ${err.message}`, "ERROR");
            metrics.connectionErrors++;
        });
    }

    placeBid(lot, amount, currentTime = null) {
        if (this.saleEnded) {
            log(`${this.name} - Impossible d'encherir (vente terminee)`, "WARNING");
            metrics.bidsAfterEnd++;
            return;
        }

        const timeInfo = currentTime !== null ? ` (timer: ${currentTime}s)` : "";
        log(`${this.name} - ENCHERE ${getPrice(amount)} sur lot ${lot}${timeInfo}`, "BID");
        metrics.bidsReceived++;

        const msg = {
            myEnchere: amount,
            lot: lot,
            email: this.email
        };

        if (currentTime !== null) {
            msg.currentTime = currentTime;
        }

        this.socket.emit("getMsgPrivate", {
            toid: "admin",
            type: "doEncheres",
            msg: msg,
            name: this.name
        });
    }

    sendFollow() {
        log(`${this.name} - Envoi follow`, "CLIENT");
        this.socket.emit("getMsgPrivate", {
            toid: "admin",
            type: "follow",
            msg: { statut: true },
            name: this.name
        });
    }

    sendReconnection() {
        log(`${this.name} - Reconnection simulee`, "CLIENT");
        this.socket.emit("getMsgPrivate", {
            toid: "admin",
            type: "reconnection",
            msg: { email: this.email, room: ROOM },
            name: this.name
        });
    }

    disconnect() {
        this.socket.disconnect();
    }
}

// ============================================
// HACKER SOCKET
// ============================================
class HackerSocket {
    constructor() {
        this.socket = io(URL, { transports: ["websocket"], reconnection: false });
        this.setupListeners();
    }

    setupListeners() {
        this.socket.on("connect", () => {
            log("Hacker connecte", "HACKER");
            this.socket.emit("joinroom", ROOM);
        });
    }

    attackSendNumLot(lot, time, price) {
        log(`TENTATIVE HACK: envoi numLot ${lot} (time:${time}s, price:${price}€)`, "HACKER");
        this.socket.emit("getMsgRoom", {
            room: ROOM,
            type: "numLot",
            msg: { numLot: lot, time: time, price: price },
            name: "Hacker"
        });
        metrics.hackerMessages++;
        metrics.unauthorizedAttempts++;
    }

    attackSpam(count, type = "message") {
        log(`TENTATIVE HACK: spam ${count} messages`, "HACKER");
        for (let i = 0; i < count; i++) {
            this.socket.emit("getMsgRoom", {
                room: ROOM,
                type: type,
                msg: { text: `Spam message ${i}` },
                name: "Spammer"
            });
        }
        metrics.hackerMessages += count;
    }

    attackInvalidTimer(lot, time) {
        log(`TENTATIVE HACK: timer invalide ${time}s sur lot ${lot}`, "HACKER");
        this.socket.emit("getMsgRoom", {
            room: ROOM,
            type: "numLot",
            msg: { numLot: lot, time: time, price: 9999999 },
            name: "Hacker"
        });
        metrics.hackerMessages++;
        metrics.invalidTimerAttempts++;
    }

    disconnect() {
        this.socket.disconnect();
    }
}

// ============================================
// CREATION DES CLIENTS
// ============================================
const clients = [
    new AuctionClient(0, "Alice Dupont", "alice@auctav.com"),
    new AuctionClient(1, "Bernard Martin", "bernard@auctav.com"),
    new AuctionClient(2, "Claire Petit", "claire@auctav.com"),
    new AuctionClient(3, "David Rousseau", "david@auctav.com"),
    new AuctionClient(4, "Emma Lefevre", "emma@auctav.com")
];

const hacker = new HackerSocket();

// ============================================
// SEQUENCE DE TESTS
// ============================================

async function runTests() {
    log("\n" + "=".repeat(50), "TEST");
    log("DEBUT DE LA SEQUENCE DE TESTS", "TEST");
    log("=".repeat(50), "TEST");

    // ========================================
    // TEST 1: Connexion et listLot
    // ========================================
    await sleep(2000);
    log("\n[TEST 1] Envoi listLot", "TEST");
    sendListLot();

    // ========================================
    // TEST 2: Message public
    // ========================================
    await sleep(3000);
    log("\n[TEST 2] Message public", "TEST");
    sendMessage("Bienvenue dans la vente aux encheres!");

    // ========================================
    // TEST 3: Follow client
    // ========================================
    await sleep(2000);
    log("\n[TEST 3] Client envoie follow", "TEST");
    clients[0].sendFollow();

    // ========================================
    // TEST 4: Reconnection client
    // ========================================
    await sleep(2000);
    log("\n[TEST 4] Reconnection client", "TEST");
    clients[1].sendReconnection();

    // ========================================
    // TEST 5: Demarrage vente lot 1
    // ========================================
    await sleep(3000);
    log("\n[TEST 5] Demarrage vente - Lot 1", "TEST");
    sendNumLot(1, lots[0].time, lots[0].price);
    saleStarted = true;

    // ========================================
    // TEST 6: Enchere normale (timer ~8s)
    // ========================================
    await sleep(2000);
    log("\n[TEST 6] Enchere normale (timer ~8s)", "TEST");
    clients[0].placeBid(1, 5500, 8);

    // ========================================
    // TEST 7: Validation enchere par admin
    // ========================================
    await sleep(2000);
    log("\n[TEST 7] Validation enchere par admin", "TEST");
    validateBid(1, 5500, clients[0].socket.id, false);

    // ========================================
    // TEST 8: Lot 2 avec Extra Time à 1s
    // ========================================
    await sleep(3000);
    log("\n[TEST 8] Lot 2 - Enchere derniere seconde (Extra Time)", "TEST");
    sendNumLot(2, 60, lots[1].price);

    await sleep(55000); // Attendre 55 secondes (timer à 5s)
    log("\n[TEST 8b] Enchere sur lot 2 (timer ~5s)", "TEST");
    clients[1].placeBid(2, 6500, 5);

    await sleep(2000);
    log("\n[TEST 8c] Validation avec EXTRA TIME", "TEST");
    validateBid(2, 6500, clients[1].socket.id, true);
    metrics.extraTimeTriggered++;

    // ========================================
    // TEST 9: Enchere pendant Extra Time
    // ========================================
    await sleep(5000);
    log("\n[TEST 9] Enchere pendant Extra Time (timer ~25s)", "TEST");
    clients[2].placeBid(2, 7000, 25);

    await sleep(2000);
    validateBid(2, 7000, clients[2].socket.id, false);

    // ========================================
    // TEST 10: Lot 3 - Enchere apres fin
    // ========================================
    await sleep(3000);
    log("\n[TEST 10] Lot 3 - Enchere apres fin (timer 0s)", "TEST");
    sendNumLot(3, 5, lots[2].price);

    await sleep(6000); // Attendre fin du timer
    log("[TEST 10b] Tentative enchere apres fin", "TEST");
    clients[3].placeBid(3, 7500, 0);

    // ========================================
    // TEST 11: Tests de securite (Hacker)
    // ========================================
    await sleep(3000);
    log("\n[TEST 11] Attaques Hacker", "TEST");
    hacker.attackSendNumLot(99, 99999, 9999999);
    hacker.attackInvalidTimer(1, 9999);
    hacker.attackSpam(15, "message");

    // ========================================
    // TEST 12: Fin de vente
    // ========================================
    await sleep(3000);
    log("\n[TEST 12] Fin de vente", "TEST");
    sendSaleEnded();

    // ========================================
    // TEST 13: Tentative enchere apres fin
    // ========================================
    await sleep(2000);
    log("\n[TEST 13] Tentative enchere apres fin de vente", "TEST");
    clients[4].placeBid(4, 8000, 30);

    // ========================================
    // TEST 14: Rejection enchere dupliquee
    // ========================================
    await sleep(2000);
    log("\n[TEST 14] Enchere dupliquee (doit etre ignoree)", "TEST");
    clients[0].placeBid(1, 5500, 10);
    clients[0].placeBid(1, 5500, 10);

    // ========================================
    // RAPPORT FINAL
    // ========================================
    await sleep(5000);
    generateReport();
}

function generateReport() {
    const duration = (Date.now() - metrics.startTime) / 1000;

    console.log("\n");
    console.log("=".repeat(70));
    console.log("RAPPORT FINAL - TEST COMPLET");
    console.log("=".repeat(70));

    console.log("\n--- STATISTIQUES GENERALES ---");
    console.log(`  Duree: ${Math.floor(duration / 60)}m ${Math.floor(duration % 60)}s`);
    console.log(`  Lots testes: ${TOTAL_LOTS}`);
    console.log(`  Clients: ${CLIENTS}`);
    console.log(`  Messages admin: ${metrics.adminMessages}`);
    console.log(`  Messages clients: ${metrics.clientMessages}`);
    console.log(`  Messages hacker: ${metrics.hackerMessages}`);

    console.log("\n--- EVENEMENTS RECUS ---");
    console.log(`  listLot: ${metrics.listLotReceived}`);
    console.log(`  numLot: ${metrics.numLotReceived}`);
    console.log(`  message: ${metrics.messageReceived}`);
    console.log(`  follow: ${metrics.followReceived}`);
    console.log(`  saleEnded: ${metrics.saleEndedReceived}`);

    console.log("\n--- ENCHERES ---");
    console.log(`  Recues: ${metrics.bidsReceived}`);
    console.log(`  Validees: ${metrics.bidsValidated}`);
    console.log(`  Refusees: ${metrics.bidsRejected}`);
    console.log(`  Apres fin: ${metrics.bidsAfterEnd}`);

    console.log("\n--- EXTRA TIME ---");
    console.log(`  Declenches: ${metrics.extraTimeTriggered}`);
    console.log(`  Detectes: ${metrics.extraTimeDetected}`);
    if (metrics.extraTimeEvents.length > 0) {
        console.log(`  Evenements:`, metrics.extraTimeEvents);
    }

    console.log("\n--- SECURITE ---");
    console.log(`  Tentatives non autorisees: ${metrics.unauthorizedAttempts}`);
    console.log(`  Timers invalides: ${metrics.invalidTimerAttempts}`);
    console.log(`  Messages dupliques: ${metrics.duplicateMessages}`);
    console.log(`  Erreurs connexion: ${metrics.connectionErrors}`);

    console.log("\n--- VERDICT ---");

    let score = 100;
    const issues = [];

    // Vérifier que les événements de base fonctionnent
    if (metrics.listLotReceived > 0) {
        console.log("  ✅ listLot recu");
    } else {
        console.log("  ❌ listLot non recu");
        score -= 20;
        issues.push("listLot non recu");
    }

    if (metrics.numLotReceived > 0) {
        console.log("  ✅ numLot recu");
    } else {
        console.log("  ❌ numLot non recu");
        score -= 20;
        issues.push("numLot non recu");
    }

    // Vérifier extra time
    if (metrics.extraTimeTriggered > 0 && metrics.extraTimeDetected > 0) {
        console.log("  ✅ Extra Time fonctionnel");
    } else {
        console.log("  ⚠️ Extra Time non fonctionnel");
        score -= 15;
        issues.push("Extra Time non fonctionnel");
    }

    // Vérifier sécurité
    if (metrics.invalidTimerAttempts === 0) {
        console.log("  ✅ Timers invalides bloques");
    } else {
        console.log("  ❌ Timers invalides acceptes!");
        score -= 30;
        issues.push("Timers invalides acceptes");
    }

    // Vérifier fin de vente
    if (metrics.saleEndedReceived > 0) {
        console.log("  ✅ Fin de vente detectee");
    } else {
        console.log("  ⚠️ Fin de vente non detectee");
        score -= 10;
        issues.push("Fin de vente non detectee");
    }

    // Vérifier encheres apres fin
    if (metrics.bidsAfterEnd > 0 && metrics.bidsRejected > 0) {
        console.log("  ✅ Encheres apres fin refusees");
    } else if (metrics.bidsAfterEnd > 0) {
        console.log("  ⚠️ Encheres apres fin non refusees");
        score -= 15;
        issues.push("Encheres apres fin acceptees");
    }

    console.log(`\n  SCORE FINAL: ${score}/100`);

    if (issues.length > 0) {
        console.log("\n--- PROBLEMES DETECTES ---");
        issues.forEach(issue => console.log(`  - ${issue}`));
    }

    console.log("\n--- DETAILS DES TIMINGS ---");
    console.log(`  Debut test: ${new Date(metrics.startTime).toLocaleTimeString()}`);
    console.log(`  Fin test: ${new Date().toLocaleTimeString()}`);

    console.log("\n" + "=".repeat(70));
    console.log("FIN DU TEST COMPLET");
    console.log("=".repeat(70));

    // Deconnexion
    adminSocket.disconnect();
    hacker.disconnect();
    clients.forEach(c => c.disconnect());

    process.exit(0);
}

// Lancer les tests
runTests().catch(err => {
    log(`Erreur: ${err.message}`, "ERROR");
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    log(`Exception non capturee: ${err.message}`, "ERROR");
    process.exit(1);
});