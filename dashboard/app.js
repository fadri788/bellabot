// --- KONFIGURATION ---
const API_BASE = "";

// Positionen der Punkte auf der Karte (Prozent: x von links, y von oben)
const POSITIONEN = {
    "Kitchen":         { x: 12, y: 35 },
    "3D Printer":      { x: 24, y: 18 },
    "Trash":           { x: 28, y: 75 },
    "Printer":         { x: 36, y: 55 },
    "Avatar":          { x: 44, y: 25 },
    "VR":              { x: 52, y: 62 },
    "Accenture Robot": { x: 60, y: 30 },
    "Meeting":         { x: 68, y: 18 },
    "Tables":          { x: 74, y: 60 },
    "Table2":          { x: 82, y: 45 },
    "TV":              { x: 88, y: 25 },
    "WC":              { x: 92, y: 70 },
};

let letzterZustand = null;
let verbindung = null;
let anfrageLaeuft = false;
let punktListe = null;
let statusNummer = 0;
let punktAbfrage = false;

function kartenSchluessel(name) {
    return name.toLowerCase().replace(/\s+/g, "");
}

function mitFreigabe() {
    return verbindung && ["live", "bridge-simulation"].includes(verbindung.mode);
}

function steuerungAktualisieren() {
    const demo = verbindung && verbindung.mode === "simulation";
    const bereit = !anfrageLaeuft && verbindung && verbindung.state !== "offline";
    document.querySelectorAll("#punkte-liste button").forEach(function (btn) {
        btn.disabled = !bereit || (!demo && !verbindung.canGo);
    });
    const pause = document.getElementById("btn-pause");
    const zurueck = document.getElementById("btn-zurueck");
    pause.textContent = mitFreigabe() ? (verbindung.canReconcile ? "Aufgabe prüfen" : "Fahrt abbrechen") : "Pause";
    pause.disabled = !bereit || (!demo && !(verbindung.canCancel || verbindung.canReconcile));
    zurueck.textContent = mitFreigabe() ? (verbindung.returnDestination ? "Zu " + verbindung.returnDestination : "Rückkehrpunkt fehlt") : "Zurück zur Basis";
    zurueck.disabled = !bereit || (!demo && !verbindung.canReturn);
}

// --- Log ---
function log(text) {
    const liste = document.getElementById("log-liste");
    const zeit = new Date().toLocaleTimeString();
    const zeile = document.createElement("div");
    zeile.className = "log-zeile";
    const uhr = document.createElement("span");
    uhr.className = "log-zeit";
    uhr.textContent = zeit;
    zeile.append(uhr, document.createTextNode(String(text)));
    liste.prepend(zeile);
    while (liste.children.length > 100) liste.lastElementChild.remove();
}

// --- 1) Status pollen ---
async function updateStatus() {
    const nummer = ++statusNummer;
    try {
        const antwort = await fetch(API_BASE + "/robot/status");
        if (!antwort.ok) throw new Error("Status nicht verfügbar");
        const daten = await antwort.json();
        if (nummer !== statusNummer) return;
        verbindung = daten;
        document.title = "BellaBot Dashboard" + (daten.simulated ? " (Simulation)" : "");
        document.querySelector("h1").textContent = document.title;
        document.querySelector(".karte h2").textContent = "Karte (schematisch)";

        const akkuEl = document.getElementById("akku");
        akkuEl.textContent = daten.battery + " %";
        if (daten.battery >= 50)      akkuEl.className = "wert akku-gut";
        else if (daten.battery >= 20) akkuEl.className = "wert akku-mittel";
        else                          akkuEl.className = "wert akku-tief";

        const zustandEl = document.getElementById("zustand");
        zustandEl.textContent = daten.state;
        zustandEl.className = "wert zustand-" + daten.state;

        document.getElementById("aufgabe").textContent = daten.task;

        markiereZiel(daten.task, daten.destination);
        steuerungAktualisieren();
        ladePunkte();

        if (daten.state !== letzterZustand) {
            log("Zustand: " + daten.state);
            letzterZustand = daten.state;
        }
    } catch (fehler) {
        if (nummer !== statusNummer) return;
        verbindung = null;
        document.getElementById("zustand").textContent = "offline";
        document.getElementById("aufgabe").textContent = "Keine Verbindung. Nicht erneut senden; laufende Aufgabe am Roboter prüfen.";
        steuerungAktualisieren();
    }
}

// --- 2) Punkte-Buttons + Karten-Marker bauen ---
async function ladePunkte() {
    if (punktAbfrage) return;
    punktAbfrage = true;
    try {
    const antwort = await fetch(API_BASE + "/points");
    if (!antwort.ok) throw new Error("Ziele nicht verfügbar");
    const daten = await antwort.json();
    const schluessel = JSON.stringify(daten.points);
    if (schluessel === punktListe) return;
    punktListe = schluessel;
    const liste = document.getElementById("punkte-liste");
    const karte = document.getElementById("karten-flaeche");
    liste.replaceChildren();
    karte.replaceChildren();

    daten.points.forEach(function (punkt) {
        const btn = document.createElement("button");
        btn.textContent = punkt;
        btn.onclick = function () { sendeZu(punkt); };
        liste.appendChild(btn);

        // Nur die schematische Position zuordnen; Befehle behalten den genauen Roboternamen.
        const schluessel = kartenSchluessel(punkt);
        const treffer = Object.entries(POSITIONEN).filter(([name]) => kartenSchluessel(name) === schluessel);
        const pos = treffer.length === 1 && daten.points.filter(name => kartenSchluessel(name) === schluessel).length === 1 ? treffer[0][1] : null;
        if (!pos) return;
        const marker = document.createElement("div");
        marker.className = "marker";
        marker.textContent = punkt;
        marker.style.left = pos.x + "%";
        marker.style.top = pos.y + "%";
        marker.dataset.punkt = punkt;
        marker.onclick = function () { sendeZu(punkt); };
        karte.appendChild(marker);
    });
    markiereZiel(verbindung?.task || "", verbindung?.destination);
    steuerungAktualisieren();
    } catch {
        punktListe = null;
        document.getElementById("punkte-liste").replaceChildren();
        document.getElementById("karten-flaeche").replaceChildren();
    } finally {
        punktAbfrage = false;
    }
}

// --- aktuellen Zielpunkt hervorheben ---
function markiereZiel(task, destination) {
    const ziel = destination || (task.startsWith("Unterwegs zu: ") ? task.replace("Unterwegs zu: ", "") : null);
    document.querySelectorAll(".marker").forEach(function (m) {
        m.classList.toggle("aktiv", m.dataset.punkt === ziel);
    });
}

// --- 3) Befehle schicken ---
async function post(pfad, koerper) {
    if (anfrageLaeuft) return;
    anfrageLaeuft = true;
    steuerungAktualisieren();
    try {
        const antwort = await fetch(API_BASE + pfad, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(koerper || {}),
        });
        const daten = await antwort.json();
        log(daten.message || (antwort.ok ? "Anfrage gesendet" : "Anfrage abgelehnt"));
    } catch {
        log("Antwort fehlt. Nicht erneut senden. Aufgabe am Roboter prüfen.");
    } finally {
        anfrageLaeuft = false;
        await updateStatus();
        steuerungAktualisieren();
    }
}

function sendeZu(punkt) {
    if (!verbindung || anfrageLaeuft || (verbindung.mode !== "simulation" && !verbindung.canGo)) return;
    const freigabe = bestaetigung("Fahrt zu " + punkt, false);
    if (freigabe === null) return;
    post("/task/delivery", { point: punkt, ...freigabe });
}

function bestaetigung(aktion, aufgabePruefen) {
    if (!mitFreigabe()) return {};
    const mapId = verbindung.mapId;
    const einleitung = verbindung.simulated ? "Simulation: " : "Bella kann sich bewegen: ";
    const pruefung = aufgabePruefen ? "Prüfe zuerst direkt am Roboter, dass keine aktive oder wartende Aufgabe mehr besteht.\n\n" : "";
    if (!window.confirm(einleitung + aktion + "\n\n" + pruefung +
        "Ich stehe am Roboter, Karte und Position stimmen, der Weg ist frei und die Stopptaste ist bereit.\n\n" +
        "Diese einzelne Aktion bestätigen?")) return null;
    return { id: crypto.randomUUID(), mapId, confirmation: {
        besideRobot: true, correctMapAndPosition: true, clearPathAndStopReady: true,
        ...(aufgabePruefen ? { robotTaskCleared: true } : {}),
    } };
}

// --- 4) Buttons verbinden ---
document.getElementById("btn-zurueck").onclick = function () {
    const freigabe = bestaetigung("Fahrt zum bestätigten Rückkehrpunkt " + (verbindung?.returnDestination || ""), false);
    if (freigabe !== null) post("/command", { action: "return", ...freigabe });
};
document.getElementById("btn-pause").onclick = function () {
    const action = mitFreigabe() ? (verbindung.canReconcile ? "reconcile" : "cancel") : "pause";
    const freigabe = bestaetigung(action === "reconcile" ? "Aufgabe nach Prüfung freigeben" : "Fahrt abbrechen. Dies ersetzt nicht die Stopptaste.", action === "reconcile");
    if (freigabe !== null) post("/command", { action, ...freigabe });
};

// --- 5) Start ---
steuerungAktualisieren();
updateStatus();
setInterval(updateStatus, 2000);
log("Dashboard gestartet");
