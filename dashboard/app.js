// --- KONFIGURATION (spaeter fuer "live" nur das hier anpassen) ---
const API_BASE = "";   // leer = gleicher Server. Spaeter z.B. "http://10.55.74.22"

// --- 1) Status alle 2 Sekunden holen (pollen) ---
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
    } catch (fehler) {
        document.getElementById("zustand").textContent = "offline";
        console.error("Status konnte nicht geladen werden:", fehler);
    }
}

// --- 2) Punkte einmal laden und Buttons bauen ---
async function ladePunkte() {
    const antwort = await fetch(API_BASE + "/points");
    const daten = await antwort.json();
    const liste = document.getElementById("punkte-liste");

    daten.points.forEach(function (punkt) {
        const btn = document.createElement("button");
        btn.textContent = punkt;
        btn.onclick = function () { sendeZu(punkt); };
        liste.appendChild(btn);
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
    post("/task/delivery", { point: punkt });
}

// --- 4) Buttons verbinden ---
document.getElementById("btn-zurueck").onclick = function () {
    post("/command", { action: "return" });
};
document.getElementById("btn-pause").onclick = function () {
    post("/command", { action: "pause" });
};

// --- 5) Start ---
ladePunkte();
updateStatus();
setInterval(updateStatus, 2000);