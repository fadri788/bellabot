// --- KONFIGURATION ---
const API_BASE = "";   // leer = gleicher Server. Spaeter z.B. "http://10.55.74.22"

let letzterZustand = null;

// --- Log-Fenster ---
function log(text) {
    const liste = document.getElementById("log-liste");
    const zeit = new Date().toLocaleTimeString();
    const zeile = document.createElement("div");
    zeile.className = "log-zeile";
    zeile.innerHTML = '<span class="log-zeit">' + zeit + '</span>' + text;
    liste.prepend(zeile);   // neueste Zeile oben
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

        // Log bei Zustandswechsel
        if (daten.state !== letzterZustand) {
            log("Zustand: " + daten.state);
            letzterZustand = daten.state;
        }
    } catch (fehler) {
        document.getElementById("zustand").textContent = "offline";
        console.error("Status konnte nicht geladen werden:", fehler);
    }
}

// --- 2) Punkte laden ---
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