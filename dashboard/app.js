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

// --- Log ---
function log(text) {
    const liste = document.getElementById("log-liste");
    const zeit = new Date().toLocaleTimeString();
    const zeile = document.createElement("div");
    zeile.className = "log-zeile";
    zeile.innerHTML = '<span class="log-zeit">' + zeit + '</span>' + text;
    liste.prepend(zeile);
}

// --- 1) Status pollen ---
async function updateStatus() {
    try {
        const antwort = await fetch(API_BASE + "/robot/status");
        const daten = await antwort.json();

        const akkuEl = document.getElementById("akku");
        akkuEl.textContent = daten.battery + " %";
        if (daten.battery >= 50)      akkuEl.className = "wert akku-gut";
        else if (daten.battery >= 20) akkuEl.className = "wert akku-mittel";
        else                          akkuEl.className = "wert akku-tief";

        const zustandEl = document.getElementById("zustand");
        zustandEl.textContent = daten.state;
        zustandEl.className = "wert zustand-" + daten.state;

        document.getElementById("aufgabe").textContent = daten.task;

        markiereZiel(daten.task);

        if (daten.state !== letzterZustand) {
            log("Zustand: " + daten.state);
            letzterZustand = daten.state;
        }
    } catch (fehler) {
        document.getElementById("zustand").textContent = "offline";
        console.error("Status konnte nicht geladen werden:", fehler);
    }
}

// --- 2) Punkte-Buttons + Karten-Marker bauen ---
async function ladePunkte() {
    const antwort = await fetch(API_BASE + "/points");
    const daten = await antwort.json();
    const liste = document.getElementById("punkte-liste");
    const karte = document.getElementById("karten-flaeche");

    daten.points.forEach(function (punkt) {
        const btn = document.createElement("button");
        btn.textContent = punkt;
        btn.onclick = function () { sendeZu(punkt); };
        liste.appendChild(btn);

        const pos = POSITIONEN[punkt] || { x: 50, y: 50 };
        const marker = document.createElement("div");
        marker.className = "marker";
        marker.textContent = punkt;
        marker.style.left = pos.x + "%";
        marker.style.top = pos.y + "%";
        marker.dataset.punkt = punkt;
        marker.onclick = function () { sendeZu(punkt); };
        karte.appendChild(marker);
    });
}

// --- aktuellen Zielpunkt hervorheben ---
function markiereZiel(task) {
    const ziel = task.startsWith("Unterwegs zu: ") ? task.replace("Unterwegs zu: ", "") : null;
    document.querySelectorAll(".marker").forEach(function (m) {
        m.classList.toggle("aktiv", m.dataset.punkt === ziel);
    });
}

// --- 3) Befehle schicken ---
async function post(pfad, koerper) {
    await fetch(API_BASE + pfad, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(koerper || {}),
    });
    updateStatus();
}

function sendeZu(punkt) {
    log("Fahrbefehl: " + punkt);
    post("/task/delivery", { point: punkt });
}

// --- 4) Buttons verbinden ---
document.getElementById("btn-zurueck").onclick = function () {
    log("Befehl: Zurueck zur Basis");
    post("/command", { action: "return" });
};
document.getElementById("btn-pause").onclick = function () {
    log("Befehl: Pause");
    post("/command", { action: "pause" });
};

// --- 5) Start ---
ladePunkte();
updateStatus();
setInterval(updateStatus, 2000);
log("Dashboard gestartet");