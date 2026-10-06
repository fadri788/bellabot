// ----------------------------------------------------------
// KONFIGURATION -- spaeter fuer "live" nur das hier anpassen
// ----------------------------------------------------------
const API_BASE = "";   // leer = gleicher Server. Spaeter z.B. "http://10.55.74.22"

// ----------------------------------------------------------
// 1) Status regelmaessig holen und Kacheln aktualisieren
// ----------------------------------------------------------
async function updateStatus() {
    try {
        const antwort = await fetch(API_BASE + "/api/status");
        const daten = await antwort.json();

        document.getElementById("akku").textContent = daten.battery + " %";
        document.getElementById("zustand").textContent = daten.state;
        document.getElementById("aufgabe").textContent = daten.task;

        zeigePunkte(daten.points);
    } catch (fehler) {
        document.getElementById("zustand").textContent = "offline";
        console.error("Status konnte nicht geladen werden:", fehler);
    }
}

// ----------------------------------------------------------
// 2) Fuer jeden Karten-Punkt einen Button bauen
// ----------------------------------------------------------
let punkteGebaut = false;

function zeigePunkte(punkte) {
    if (punkteGebaut) return;   // nur einmal bauen
    const liste = document.getElementById("punkte-liste");

    punkte.forEach(function (punkt) {
        const btn = document.createElement("button");
        btn.textContent = punkt;
        btn.onclick = function () { sendeZu(punkt); };
        liste.appendChild(btn);
    });

    punkteGebaut = true;
}

// ----------------------------------------------------------
// 3) Befehle an den Roboter schicken
// ----------------------------------------------------------
async function sendeBefehl(pfad, koerper) {
    await fetch(API_BASE + pfad, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(koerper || {}),
    });
    updateStatus();   // danach sofort aktualisieren
}

function sendeZu(punkt) {
    sendeBefehl("/api/send", { point: punkt });
}

// ----------------------------------------------------------
// 4) Buttons mit Funktionen verbinden
// ----------------------------------------------------------
document.getElementById("btn-zurueck").onclick = function () {
    sendeBefehl("/api/return");
};
document.getElementById("btn-pause").onclick = function () {
    sendeBefehl("/api/pause");
};

// ----------------------------------------------------------
// 5) Start: sofort laden und dann alle 2 Sekunden wiederholen
// ----------------------------------------------------------
updateStatus();
setInterval(updateStatus, 2000);