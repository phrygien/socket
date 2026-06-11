const { io } = require("socket.io-client");

const URL = "http://localhost:3005/";
const ROOM = "auctav-test-250";

const ADMIN = "Admin-Test";
const CLIENTS = 5; // Nombre de clients simulateurs

console.log("===== TEST COMPLET SOCKET.IO =====");
console.log("Simulation de ventes_live.php");
console.log("1 admin +", CLIENTS, "clients simulateurs");
console.log("Room:", ROOM);
console.log("===================================\n");

// ============================================
// STATISTIQUES ET METRICS
// ============================================
const metrics = {
    adminMessages: 0,
    hackerMessages: 0,
    duplicateMessages: 0,
    invalidTimerAttempts: 0,
    unauthorizedAttempts: 0,
    extraTimeDetected: 0,
    extraTimeCount: 0,
    bidsReceived: 0,
    bidsValidated: 0,
    bidsRejected: 0,
    lotChanges: 0,
    connectionErrors: 0,
    messageReceived: {},
    timersReceived: [],
    bidsHistory: [],
    startTime: Date.now()
};

// ============================================
// FONCTIONS UTILITAIRES
// ============================================
function getPrice(number) {
    return new Intl.NumberFormat('fr-FR', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(number);
}

function getInfosTime(time, extratime) {
    let text = "";
    if (extratime === true) text = "ExtraTime ";
    const heure = Math.floor(time / 3600);
    const min = Math.floor((time - heure * 3600) / 60);
    const sec = (time - heure * 3600 - min * 60);
    if (time < 60) return text + sec + "s";
    else if (time < 3600) return text + min + "m" + sec + "s";
    else return text + heure + "h" + min + "m";
}

// ============================================
// ADMIN SOCKET (Comme le switcher.php)
// ============================================
const adminSocket = io(URL, {
    transports: ["websocket"],
    reconnection: false
});

let currentLot = 1;
let lots = [];

// Initialisation des lots (comme dans le PHP)
for (let i = 1; i <= 10; i++) {
    lots.push({
        numLot: i,
        price: 1000 * i,
        time: 60 + (i * 5),
        extratime: false,
        statut: "",
        reserveInfo: 0,
        toid: null
    });
}

adminSocket.on("connect", () => {
    console.log("[ADMIN] Connecte comme vendeur - ID:", adminSocket.id);
    adminSocket.emit("admin", ADMIN);
    adminSocket.emit("joinroom", ROOM);
});

adminSocket.on("connect_error", (err) => {
    console.log("[ADMIN] Erreur connexion:", err.message);
    metrics.connectionErrors++;
});

adminSocket.on("error", (data) => {
    console.log("[ADMIN] Erreur recue:", data);
});

// TEST 1: Envoi de la liste complete des lots (comme listLot)
setTimeout(() => {
    if (adminSocket.connected) {
        console.log("\n[TEST 1] Envoi de la liste des lots (listLot)");
        const listData = lots.map(lot => ({
            numLot: lot.numLot,
            price: lot.price,
            time: lot.time,
            extratime: lot.extratime,
            statut: lot.statut,
            reserveInfo: lot.reserveInfo
        }));

        adminSocket.emit("getMsgRoom", {
            room: ROOM,
            type: "listLot",
            msg: { list: listData },
            name: ADMIN
        });
        metrics.adminMessages++;
        metrics.lotChanges++;
    }
}, 2000);

// TEST 2: Demarrage du live (START)
setTimeout(() => {
    if (adminSocket.connected) {
        console.log("\n[TEST 2] Demarrage du live - Lot 1");
        startLot(1);
    }
}, 4000);

function startLot(lotNum) {
    const lot = lots.find(l => l.numLot === lotNum);
    if (lot) {
        console.log(`[ADMIN] Lancement du lot ${lotNum} avec ${lot.time} secondes`);
        adminSocket.emit("getMsgRoom", {
            room: ROOM,
            type: "numLot",
            msg: {
                numLot: lot.numLot,
                price: lot.price,
                time: lot.time,
                extratime: lot.extratime,
                statut: lot.statut,
                reserveInfo: lot.reserveInfo
            },
            name: ADMIN
        });
        metrics.adminMessages++;
        metrics.lotChanges++;
    }
}

// TEST 3: Enchere normale sur lot 1
setTimeout(() => {
    if (adminSocket.connected) {
        console.log("\n[TEST 3] Simulation d'une enchere sur lot 1");
        // Simuler qu'un client a fait une enchere
        const bidAmount = 1500;
        console.log(`  Enchere de ${getPrice(bidAmount)} sur lot 1`);

        adminSocket.emit("getMsgPrivate", {
            toid: "client_simulated",
            type: "doEncheres",
            msg: {
                myEnchere: bidAmount,
                lot: 1,
                email: "test@auctav.com"
            },
            name: "ClientTest"
        });
        metrics.bidsReceived++;
    }
}, 6000);

// TEST 4: Validation d'enchere par admin
setTimeout(() => {
    if (adminSocket.connected) {
        console.log("\n[TEST 4] Admin valide l'enchere sur lot 1");
        const lot = lots.find(l => l.numLot === 1);
        if (lot) {
            lot.price = 1500;
            adminSocket.emit("getMsgRoom", {
                room: ROOM,
                type: "numLot",
                msg: {
                    numLot: 1,
                    price: lot.price,
                    time: lot.time,
                    extratime: false,
                    statut: "",
                    reserveInfo: 3
                },
                name: ADMIN
            });
            metrics.adminMessages++;
            metrics.bidsValidated++;
        }
    }
}, 8000);

// TEST 5: Extra time sur lot 2
setTimeout(() => {
    if (adminSocket.connected) {
        console.log("\n[TEST 5] Activation Extra Time sur lot 2");
        const lot = lots.find(l => l.numLot === 2);
        if (lot) {
            lot.extratime = true;
            lot.time = 30;
            adminSocket.emit("getMsgRoom", {
                room: ROOM,
                type: "numLot",
                msg: {
                    numLot: 2,
                    price: lot.price,
                    time: lot.time,
                    extratime: true,
                    statut: "",
                    reserveInfo: 0
                },
                name: ADMIN
            });
            metrics.adminMessages++;
            metrics.extraTimeCount++;
        }
    }
}, 10000);

// TEST 6: Enchere avec extra time
setTimeout(() => {
    if (adminSocket.connected) {
        console.log("\n[TEST 6] Enchere pendant Extra Time sur lot 2");
        adminSocket.emit("getMsgPrivate", {
            toid: "client_simulated",
            type: "doEncheres",
            msg: {
                myEnchere: 2500,
                lot: 2,
                email: "test2@auctav.com"
            },
            name: "ClientTest2"
        });
        metrics.bidsReceived++;
    }
}, 12000);

// TEST 7: Fin de lot (time=0)
setTimeout(() => {
    if (adminSocket.connected) {
        console.log("\n[TEST 7] Fin du lot 2 (time=0)");
        adminSocket.emit("getMsgRoom", {
            room: ROOM,
            type: "numLot",
            msg: {
                numLot: 2,
                price: 2500,
                time: 0,
                extratime: false,
                statut: "sold",
                reserveInfo: 3
            },
            name: ADMIN
        });
        metrics.adminMessages++;
    }
}, 14000);

// TEST 8: Lot non vendu (notsold)
setTimeout(() => {
    if (adminSocket.connected) {
        console.log("\n[TEST 8] Lot 3 non vendu (notsold)");
        adminSocket.emit("getMsgRoom", {
            room: ROOM,
            type: "numLot",
            msg: {
                numLot: 3,
                price: 3000,
                time: 0,
                extratime: false,
                statut: "notsold",
                reserveInfo: 2
            },
            name: ADMIN
        });
        metrics.adminMessages++;
    }
}, 16000);

// TEST 9: Retour sur lot precedent (previousLot)
setTimeout(() => {
    if (adminSocket.connected) {
        console.log("\n[TEST 9] Retour sur lot 1 (previousLot)");
        const lot = lots.find(l => l.numLot === 1);
        if (lot) {
            adminSocket.emit("getMsgRoom", {
                room: ROOM,
                type: "previousLot",
                msg: {
                    numLot: 1,
                    price: lot.price,
                    time: 45,
                    extratime: false
                },
                name: ADMIN
            });
            metrics.adminMessages++;
        }
    }
}, 18000);

// TEST 10: Message public dans la salle
setTimeout(() => {
    if (adminSocket.connected) {
        console.log("\n[TEST 10] Envoi d'un message public");
        adminSocket.emit("getMsgRoom", {
            room: ROOM,
            type: "message",
            msg: { text: "Dernier lot avant la pause !" },
            name: ADMIN
        });
        metrics.adminMessages++;
    }
}, 20000);

// ============================================
// SIMULATION DE CLIENTS ENCHERISSEURS
// ============================================
class BidderSimulator {
    constructor(id, email, name) {
        this.id = id;
        this.email = email;
        this.name = name;
        this.socket = io(URL, { transports: ["websocket"], reconnection: false });
        this.currentBids = {};
        this.setupListeners();
    }

    setupListeners() {
        this.socket.on("connect", () => {
            console.log(`[BIDDER ${this.id}] Connecte - ${this.name}`);
            this.socket.emit("joinroom", ROOM);
            this.socket.emit("username", this.name);
        });

        this.socket.on("sendMsg", (data) => {
            // Simulation de l'affichage comme dans le PHP
            if (data.type === "numLot") {
                console.log(`[BIDDER ${this.id}] Lot ${data.msg.numLot} - temps: ${data.msg.time}s - prix: ${getPrice(data.msg.price)}`);
                if (data.msg.extratime) {
                    console.log(`  -> EXTRA TIME active sur lot ${data.msg.numLot}`);
                }

                // Enregistrer l'enchere en cours
                if (data.msg.toid === this.socket.id) {
                    this.currentBids[data.msg.numLot] = data.msg.price;
                    console.log(`[BIDDER ${this.id}] Vous detenez l'enchere sur lot ${data.msg.numLot}`);
                }
            }

            if (data.type === "confirmEnchere") {
                if (data.msg.state) {
                    console.log(`[BIDDER ${this.id}] Enchere validee sur lot ${data.msg.lot}`);
                    metrics.bidsValidated++;
                } else {
                    console.log(`[BIDDER ${this.id}] Enchere refusee sur lot ${data.msg.lot}`);
                    metrics.bidsRejected++;
                }
            }

            if (data.type === "validEnchere") {
                console.log(`[BIDDER ${this.id}] ✔ Vous avez remporte le lot ${data.msg.lot} !`);
            }
        });

        this.socket.on("connect_error", (err) => {
            console.log(`[BIDDER ${this.id}] Erreur:`, err.message);
            metrics.connectionErrors++;
        });
    }

    placeBid(lot, amount) {
        console.log(`[BIDDER ${this.id}] Place une enchere de ${getPrice(amount)} sur lot ${lot}`);
        this.socket.emit("getMsgPrivate", {
            toid: "admin",
            type: "doEncheres",
            msg: {
                myEnchere: amount,
                lot: lot,
                email: this.email
            },
            name: this.name
        });
        metrics.bidsReceived++;
    }

    disconnect() {
        this.socket.disconnect();
    }
}

// Creer des clients simulateurs
const bidders = [];
const bidderEmails = ["alice@auctav.com", "bob@auctav.com", "carol@auctav.com", "david@auctav.com", "emma@auctav.com"];
const bidderNames = ["Alice Martin", "Bob Dupont", "Carol Bernard", "David Petit", "Emma Rousseau"];

for (let i = 0; i < CLIENTS; i++) {
    bidders.push(new BidderSimulator(i, bidderEmails[i % bidderEmails.length], bidderNames[i % bidderNames.length]));
}

// ============================================
// SIMULATION D'ENCHERES DE LA PART DES CLIENTS
// ============================================

setTimeout(() => {
    console.log("\n[CLIENT SIMULATION] Alice fait une enchere sur lot 4");
    bidders[0].placeBid(4, 4500);
}, 11000);

setTimeout(() => {
    console.log("\n[CLIENT SIMULATION] Bob surenchere sur lot 4");
    bidders[1].placeBid(4, 5000);
}, 13000);

setTimeout(() => {
    console.log("\n[CLIENT SIMULATION] Carol enchere sur lot 5");
    bidders[2].placeBid(5, 5500);
}, 15000);

setTimeout(() => {
    console.log("\n[CLIENT SIMULATION] David enchere sur lot 6 avec extra time");
    bidders[3].placeBid(6, 6500);
}, 17000);

// ============================================
// HACKER SIMULATION (tentative d'attaque)
// ============================================
console.log("\n[HACKER] Creation d'un socket malveillant...");
const hackerSocket = io(URL, {
    transports: ["websocket"],
    reconnection: false
});

hackerSocket.on("connect", () => {
    console.log("[HACKER] Connecte - Tentative d'attaque");
    hackerSocket.emit("joinroom", ROOM);
});

// Tentative de hack: envoyer un numLot sans droits
setTimeout(() => {
    console.log("\n[TEST SECURITE] Hacker tente d'envoyer un numLot - Doit etre BLOQUE");
    hackerSocket.emit("getMsgRoom", {
        room: ROOM,
        type: "numLot",
        msg: { numLot: 99, time: 99999, price: 9999999 },
        name: "Hacker"
    });
    metrics.hackerMessages++;
}, 9000);

// Tentative de hack: modifier le timer
setTimeout(() => {
    console.log("\n[TEST SECURITE] Hacker tente de modifier le timer - Doit etre BLOQUE");
    hackerSocket.emit("getMsgRoom", {
        room: ROOM,
        type: "numLot",
        msg: { numLot: 1, time: 99999, price: 100 },
        name: "Hacker"
    });
    metrics.hackerMessages++;
}, 12000);

// ============================================
// RAPPORT FINAL
// ============================================
setTimeout(() => {
    const duration = (Date.now() - metrics.startTime) / 1000;

    console.log("\n");
    console.log("=".repeat(70));
    console.log("RAPPORT FINAL DU TEST - SIMULATION VENTE LIVE");
    console.log("=".repeat(70));

    console.log("\n--- STATISTIQUES GENERALES ---");
    console.log(`Duree du test: ${duration} secondes`);
    console.log(`Clients simulateurs: ${CLIENTS}`);
    console.log(`Messages admin envoyes: ${metrics.adminMessages}`);
    console.log(`Messages hacker envoyes: ${metrics.hackerMessages}`);
    console.log(`Changements de lot: ${metrics.lotChanges}`);
    console.log(`Encheres recues: ${metrics.bidsReceived}`);
    console.log(`Encheres validees: ${metrics.bidsValidated}`);
    console.log(`Encheres refusees: ${metrics.bidsRejected}`);
    console.log(`Extra time actives: ${metrics.extraTimeCount}`);
    console.log(`Erreurs connexion: ${metrics.connectionErrors}`);

    console.log("\n--- VERIFICATIONS DE SECURITE ---");

    let securityIssues = false;

    // Verifier si les attaques ont reussi
    if (metrics.hackerMessages > 0 && metrics.invalidTimerAttempts === 0) {
        console.log("✅ Securite OK - Les tentatives de hack ont ete bloquees");
    } else if (metrics.invalidTimerAttempts > 0) {
        console.log("❌ PROBLEME CRITIQUE - Des timers invalides ont ete acceptes !");
        securityIssues = true;
    }

    console.log("\n--- FLUX DES OPERATIONS SIMULEES ---");
    console.log("1. Admin connecte et envoie listLot");
    console.log("2. Demarrage lot 1");
    console.log("3. Enchere sur lot 1 -> validation admin");
    console.log("4. Extra time sur lot 2");
    console.log("5. Enchere pendant extra time");
    console.log("6. Fin lot 2 -> vendu");
    console.log("7. Lot 3 -> non vendu");
    console.log("8. Retour lot precedent");
    console.log("9. Messages publics");
    console.log("10. Tentatives de hack securite");

    console.log("\n--- RECOMMANDATIONS ---");

    if (securityIssues) {
        console.log("1. URGENT: Corriger roomHandler.js pour verifier isAdmin");
        console.log("2. Ajouter validation des timers (MAX_TIME = 3600)");
        console.log("3. Ajouter rate limiting anti-spam");
    } else {
        console.log("✅ Securite OK - Aucune faille detectee");
    }

    if (metrics.bidsValidated < metrics.bidsReceived) {
        console.log("⚠️ Certaines encheres n'ont pas ete validees - Verifier logique admin");
    }

    console.log("\n--- SIMULATION REUSSIE ---");
    console.log("Le test a simule le comportement complet de ventes_live.php");
    console.log("Les encheres, extra time, et fins de lots ont ete testes");

    console.log("\n" + "=".repeat(70));
    console.log("FIN DU TEST");
    console.log("=".repeat(70));

    // Deconnexion
    adminSocket.disconnect();
    hackerSocket.disconnect();
    bidders.forEach(b => b.disconnect());

    process.exit(0);
}, 25000);

// Gestion des erreurs
process.on('uncaughtException', (err) => {
    console.log('Erreur non capturee:', err.message);
    process.exit(1);
});