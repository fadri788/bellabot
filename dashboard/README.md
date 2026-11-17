# BellaBot Dashboard

Web-Dashboard zum Steuern und Überwachen des Pudu BellaBot.
Standardmässig läuft es gegen einen **Mock** (simulierter Roboter). Mit den
anderen Modi liest bzw. steuert es den echten Roboter über die lokale
[Robot Bridge](../robot_bridge/README.md).

## Aufbau

| Datei               | Aufgabe                                                        |
|---------------------|----------------------------------------------------------------|
| `mock_server.py`    | Flask-Server: liefert Webseite + API, enthält den simulierten Roboter (`MockRobot`) |
| `local_reader.py`   | Adapter für `read-only`: liest den Zustand der Bridge, sendet nie Befehle |
| `gated_robot.py`    | Adapter für `bridge-simulation` und `live`: prüft Verbindung, Karte und Bestätigung, bevor ein Befehl an die Bridge geht |
| `index.html`        | Gerüst (Status-Kacheln, Steuerung, Punkte-Liste, Karte, Log)   |
| `style.css`         | Aussehen (dunkles Design, Farben, Verlauf)                     |
| `app.js`            | Holt Status (Polling), schickt Befehle, fragt Bestätigungen ab |
| `requirements.txt`  | Python-Abhängigkeiten (`Flask==3.1.3`)                         |
| `tests/`            | Unit-Tests (Python) und Browser-Tests (Playwright)             |

## Starten

Am einfachsten über den Starter im Hauptordner, der auch `.venv` einrichtet:

```bash
python start_demo.py
```

Oder direkt:

```bash
cd dashboard
pip install -r requirements.txt   # einmalig
python mock_server.py
```

Browser: **http://127.0.0.1:5000** (über den Server, nicht die Datei direkt).
Stoppen: im Terminal `Strg + C`.

Optionen von `mock_server.py`:

| Option   | Standard     | Bedeutung                                                     |
|----------|--------------|---------------------------------------------------------------|
| `--port` | `5000`       | Lokaler Port                                                  |
| `--mode` | `simulation` | `simulation`, `read-only`, `bridge-simulation` oder `live`    |

Für `read-only`, `bridge-simulation` und `live` muss die Robot Bridge auf
`127.0.0.1:3443` laufen. `start_demo.py --mode …` startet beides zusammen.

## Modi

| Modus               | Adapter          | Fahrbefehle                                               |
|---------------------|------------------|-----------------------------------------------------------|
| `simulation`        | `MockRobot`      | simuliert: Lieferung → Rückkehr → Laden                   |
| `read-only`         | `LocalRobotReader` | keine, werden mit Hinweis abgelehnt                     |
| `bridge-simulation` | `GatedRobot`     | gehen an die Bridge im Simulationsmodus                   |
| `live`              | `GatedRobot`     | gehen an die Bridge und von dort an Bella                 |

## API-Endpunkte

Alle Antworten sind JSON. Der Server antwortet nur auf Anfragen von
`127.0.0.1` und blockt POSTs von fremden Seiten (Cross-Site).

| Methode | Pfad             | Wirkung                                                     |
|---------|------------------|-------------------------------------------------------------|
| GET     | `/robot/status`  | Aktueller Zustand, siehe unten                              |
| GET     | `/points`        | `{ "points": [...] }`, Liste der anfahrbaren Karten-Punkte  |
| POST    | `/task/delivery` | Fahrt zu einem Punkt starten                                |
| POST    | `/command`       | Steuerbefehl senden                                         |

### `GET /robot/status`

```json
{ "battery": 92, "state": "idle", "task": "-", "simulated": true, "mode": "simulation" }
```

- `battery`: Akku in Prozent, oder `"--"` wenn unbekannt
- `state`: z. B. `idle`, `delivering`, `returning`, `charging`, `paused`,
  `moving`, `busy`, `offline`, `unknown`
- `task`: Beschreibung der aktuellen Aufgabe bzw. Hinweis für den Operator

In `bridge-simulation` und `live` kommen dazu: `canGo`, `canCancel`,
`canReturn`, `canReconcile` (welche Buttons erlaubt sind), `mapId`,
`destination` und `returnDestination`.

### `POST /task/delivery`

```json
{ "point": "Kitchen" }
```

`point` muss in der Liste von `/points` stehen. In `bridge-simulation` und
`live` sind zusätzlich nötig:

- `id`: neue UUID pro Anfrage
- `mapId`: ID der Karte, die das Dashboard gerade anzeigt
- `confirmation`: `{ "besideRobot": true, "correctMapAndPosition": true, "clearPathAndStopReady": true }`

Diese Felder füllt `app.js` aus, nachdem der Operator im Bestätigungsdialog
zugestimmt hat.

### `POST /command`

```json
{ "action": "return" }
```

| `action`    | `simulation`         | `bridge-simulation` / `live`                           |
|-------------|----------------------|--------------------------------------------------------|
| `pause`     | Simulation anhalten  | nicht verfügbar                                        |
| `return`    | zurück zur Basis     | Fahrt zum eingerichteten Rückkehrpunkt                 |
| `cancel`    | –                    | laufende Fahrt abbrechen                               |
| `reconcile` | –                    | Sperre nach unklarem Ergebnis aufheben (Operator hat Aufgabe am Roboter geprüft, `confirmation.robotTaskCleared: true`) |

Für `bridge-simulation` und `live` gelten dieselben Zusatzfelder
(`id`, `mapId`, `confirmation`) wie bei `/task/delivery`.

### Antworten auf POSTs

```json
{ "ok": true, "message": "Simulierte Lieferung zu Kitchen gestartet" }
```

| Code  | Bedeutung                                                  |
|-------|------------------------------------------------------------|
| `200` | Befehl angenommen                                          |
| `400` | Ungültiges JSON, unbekannter Punkt oder unbekannter Befehl |
| `403` | Anfrage nicht vom eigenen Laptop oder von fremder Seite    |
| `409` | Befehl abgelehnt (z. B. Aufgabe läuft schon, Bestätigung fehlt, nur Anzeige) |

Meldet eine Antwort `"outcome": "unknown"`, ist unklar, ob Bella den Befehl
erhalten hat. Dann **nicht erneut senden**, sondern den Roboter prüfen und
danach `reconcile` verwenden.

## Tests

```bash
python -m unittest discover -s tests
```

Die Browser-Tests (`tests/browser-*.cjs`) brauchen `playwright-core`.
`browser-control.cjs` erwartet ein laufendes Dashboard im Modus
`bridge-simulation`, zum Beispiel mit `test-control.cmd` gestartet.
