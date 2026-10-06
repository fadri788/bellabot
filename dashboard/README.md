# BellaBot Dashboard

Web-Dashboard zum Steuern und Überwachen des Pudu BellaBot.
Läuft gegen einen **Mock** (simulierter Roboter), dessen Endpoints wie die
echte Cloud-API geformt sind. Später: nur Adresse + Auth-Header tauschen.

## Aufbau

| Datei            | Aufgabe                                             |
|------------------|-----------------------------------------------------|
| `mock_server.py` | Flask-Server: liefert Webseite + API, simuliert den Roboter |
| `index.html`     | Gerüst (Status-Kacheln, Buttons, Punkte-Liste)      |
| `style.css`      | Aussehen (dunkles Design, Farben, Verlauf)          |
| `app.js`         | Holt Status (Polling) und schickt Befehle           |

## Starten

```bash
pip install flask          # einmalig
cd dashboard
python mock_server.py
```

Browser: **http://127.0.0.1:5000** (über den Server, nicht die Datei direkt).
Stoppen: im Terminal `Strg + C`.

## API-Endpunkte

| Methode | Pfad             | Wirkung                                   |
|---------|------------------|-------------------------------------------|
| GET     | `/robot/status`  | `{ battery, state, task }`                |
| GET     | `/points`        | Liste der Karten-Punkte                   |
| POST    | `/task/delivery` | Lieferung starten