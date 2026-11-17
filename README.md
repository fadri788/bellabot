# bellabot

Lernprojekt rund um den Servierroboter **Pudu BellaBot**: Recherche zu den
Programmier-Schnittstellen, ein lokales **Web-Dashboard** zum Überwachen und
Steuern und eine lokale **Robot Bridge** für beaufsichtigte Fahrten zu
benannten Zielen.

> ⚠️ **Sicherheit zuerst:** Bella fährt zwischen Menschen. Echte Fahrten nur mit
> einer Person direkt neben dem Roboter und dem Notaus-Knopf in Reichweite.
> Ohne Angabe startet immer die **Simulation**, dort bewegt sich nichts.

---

## Inhalt

- [Projektstruktur](#projektstruktur)
- [Voraussetzungen](#voraussetzungen)
- [Schnellstart (Simulation)](#schnellstart-simulation)
- [Betriebsmodi](#betriebsmodi)
- [Architektur](#architektur)
- [Echten Roboter verbinden](#echten-roboter-verbinden)
- [Sicherheitsmechanismen](#sicherheitsmechanismen)
- [Pudu Cloud API](#pudu-cloud-api)
- [Tests](#tests)
- [Fehlerbehebung](#fehlerbehebung)
- [Dokumentation](#dokumentation)
- [Grundsätze](#grundsätze)

---

## Projektstruktur

| Pfad | Inhalt |
|------|--------|
| `start_demo.py` | Zentraler Starter: richtet `.venv` ein, startet Dashboard und (je nach Modus) die Bridge |
| `start-demo.cmd` | Windows-Doppelklick: Simulation |
| `test-control.cmd` | Windows-Doppelklick: Bridge-Simulation (ganzer Steuerweg, ohne Roboter) |
| `start-robot.cmd` | Windows-Doppelklick: beaufsichtigte Fahrten mit dem echten Roboter |
| `dashboard/` | Flask-Server und Weboberfläche (HTML/CSS/JS), siehe [`dashboard/README.md`](dashboard/README.md) |
| `robot_bridge/` | Node.js-Dienst: spricht lokal mit Bella (MQTT über TLS) und gibt dem Dashboard Status und Steuerung weiter, siehe [`robot_bridge/README.md`](robot_bridge/README.md) |
| `robot_bridge/prepare-robot.ps1` | Einmalige Vorbereitung für den echten Roboter (Konfiguration, Zertifikat, Firewall) |
| `robot-config.example.json` | Vorlage für die lokale Roboter-Konfiguration `.robot-local.json` |
| `scripts/pudu_status.py` | Beispiel: Roboterstatus über die Pudu Cloud API abfragen |
| `docs/` | Notizen, Recherche, Forschungs-Tagebuch |
| `.agents/skills/pudu-openapi-skill/` | Offizielle Pudu-API-Beschreibung für AI-Coding-Tools (Version in `skills-lock.json`) |

---

## Voraussetzungen

| Was | Wofür |
|-----|-------|
| **Python 3** | Dashboard. Flask 3.1.3 installiert der Starter automatisch in `.venv`. |
| **Node.js ≥ 22.9** | Nur für die Modi mit Bridge (`bridge-simulation`, `read-only`, `live`) |
| **PowerShell ≥ 7.2** | Nur zur Vorbereitung der echten Roboter-Verbindung |
| **Windows** | Empfohlen (`.cmd`-Starter, automatische Firewall-Regel). Die Simulation läuft auch unter Linux/macOS. |

---

## Schnellstart (Simulation)

Unter Windows: **`start-demo.cmd`** doppelklicken. Oder im Terminal:

```bash
python start_demo.py
```

Danach im Browser öffnen: **http://127.0.0.1:5000/?mode=simulation**

- Beim ersten Start wird `.venv` angelegt und Flask installiert.
- Fenster offen lassen, stoppen mit `Strg + C`.
- Läuft das Dashboard schon, startet der Starter keinen zweiten Server.

Nützliche Optionen:

```bash
python start_demo.py --check
```

```bash
python start_demo.py --port 5001
```

`--check` prüft nur die Einrichtung, ohne etwas zu installieren oder zu starten.
`--port` wählt einen anderen lokalen Port (1024–65535).

---

## Betriebsmodi

Der Modus wird mit `--mode` gewählt:

| Modus | Start | Was passiert | Roboter nötig? |
|-------|-------|--------------|----------------|
| `simulation` *(Standard)* | `start-demo.cmd` | Ein simulierter Roboter in Python: Lieferung → Rückkehr → Laden, Akku sinkt und steigt | nein |
| `bridge-simulation` | `test-control.cmd` | Dashboard **und** Bridge mit `--simulate`. Testet den kompletten Steuerweg inkl. Bestätigungen, aber ohne Roboter | nein |
| `read-only` | `python start_demo.py --mode read-only` | Bridge verbindet sich mit Bella und liest nur Status, Ziele und Karte. Es werden keine Fahrbefehle gesendet. | ja |
| `live` | `start-robot.cmd` | Beaufsichtigte Fahrten zu benannten Zielen und Abbrechen. Im Terminal muss `DRIVE` eingetippt werden, jede Fahrt wird im Browser bestätigt. | ja |

Empfohlene Reihenfolge: `simulation` → `bridge-simulation` → `read-only` → `live`.

---

## Architektur

```
 Browser                Dashboard (Flask)           Robot Bridge (Node.js)          BellaBot
┌─────────┐  HTTP     ┌───────────────────┐  HTTP  ┌───────────────────────┐  MQTT  ┌──────────┐
│ app.js  │ ───────▶  │ 127.0.0.1:5000    │ ─────▶ │ 127.0.0.1:3443        │ ◀───── │  Bella   │
│         │ ◀───────  │ mock_server.py    │ ◀───── │ Laptop-IP:8443 (TLS)  │ ─────▶ │ (Android)│
└─────────┘           └───────────────────┘        └───────────────────────┘        └──────────┘
```

- **Dashboard** (`dashboard/`): liefert die Webseite und eine kleine API
  (`/robot/status`, `/points`, `/task/delivery`, `/command`). Je nach Modus
  steckt dahinter der Python-Mock (`MockRobot`), der Lese-Adapter
  (`local_reader.py`) oder der Steuer-Adapter (`gated_robot.py`).
- **Robot Bridge** (`robot_bridge/`): stellt auf `127.0.0.1:3443` den Zustand
  bereit (`GET /state`) und nimmt geprüfte Steuerbefehle an. Bella verbindet
  sich selbst zum Laptop: Die Bridge lauscht auf Port **8443** als kleiner
  MQTT-3.1.1-Gegenpart über TLS, nur für diesen einen Roboter.
- Alle Dienste hören nur auf `127.0.0.1`, mit Ausnahme des Ports 8443 für den
  Roboter.

---

## Echten Roboter verbinden

> Nur mit Erlaubnis der verantwortlichen Person und nur im eigenen Netz.

1. **Gleiches Netzwerk:** Laptop und Bella ins selbe WLAN bringen (z. B. Handy-Hotspot).
2. **Adressen notieren:** IP-Adresse des Laptops sowie IP- und MAC-Adresse von
   Bella (in Bellas WLAN-Einstellungen nachsehen).
3. **Vorbereiten** (PowerShell 7.2+, unter Windows als Administrator wegen der Firewall-Regel):

   ```bash
   pwsh robot_bridge/prepare-robot.ps1 -LaptopIp <LAPTOP-IP> -RobotIp <ROBOTER-IP> -RobotMac <ROBOTER-MAC> -ReturnDestination <ZIEL> -DryRun
   ```

   Mit `-DryRun` wird nur angezeigt, was passieren würde. Ohne `-DryRun` macht das Skript Folgendes:
   - prüft, ob die MAC-Adresse wirklich zu dieser IP gehört,
   - speichert `.robot-local.json` (Aufbau wie `robot-config.example.json`),
   - erstellt ein **7 Tage** gültiges, selbst signiertes Zertifikat in `.robot-runtime/`,
   - erlaubt unter Windows nur diesem Roboter den Zugriff auf TCP 8443.

   `-ReturnDestination` ist optional und nennt das Ziel für die Rückfahrt.
4. **Bella einstellen** (mit Erlaubnis des Operators): unter *Robot API / Local / Host*
   die Laptop-IP mit Port **8443** eintragen.
5. **Erst lesen, dann fahren:**

   ```bash
   python start_demo.py --mode read-only
   ```

   Wenn Status und Ziele stimmen, `start-robot.cmd` (Modus `live`) starten und im
   Terminal `DRIVE` eintippen.

Die Bridge kann ihre Einrichtung auch selbst prüfen:

```bash
node robot_bridge/index.js --check
```

---

## Sicherheitsmechanismen

- **Simulation ist der Standard.** Echte Befehle gibt es nur im Modus `live`.
- **Nur lokal:** Das Dashboard beantwortet nur Anfragen von `127.0.0.1` und blockt
  Cross-Site-POSTs.
- **Richtiger Roboter:** Die Bridge prüft vor dem Start und vor jedem Befehl, ob
  die MAC-Adresse in der ARP-Tabelle zur konfigurierten IP passt.
- **Doppelte Freigabe:** `DRIVE` im Terminal (nur interaktiv) und eine Bestätigung
  im Browser für jede einzelne Fahrt.
- **Kleine Befehlsliste:** nur Fahrt zu einem benannten Ziel, Abbrechen und
  Abgleich durch den Operator.
- **Zeitlimit:** Eine Bridge-Sitzung endet automatisch nach **2 Stunden**.
- **Protokoll:** Befehle im Live-Modus landen in `.robot-runtime/command-journal.json`.
- **Keine Geheimnisse im Repo:** `.robot-local.json`, `.robot-runtime/` und `.env`
  stehen in `.gitignore`.

---

## Pudu Cloud API

Neben dem lokalen Weg bietet Pudu eine offizielle **Cloud API** (REST/JSON,
signiert mit HMAC-SHA1). Ein Beispiel liegt in `scripts/pudu_status.py`:

```powershell
pip install requests
$env:PUDU_API_APP_KEY = "dein-key"
$env:PUDU_API_APP_SECRET = "dein-secret"
python scripts/pudu_status.py SERIENNUMMER
```

Das Skript nutzt den Cluster `de` und gibt Status, Akkustand und Ladezustand aus.
Eine Übersicht der Endpunkte steht in [`docs/research.md`](docs/research.md) und in
`.agents/skills/pudu-openapi-skill/`.

---

## Tests

**Robot Bridge** (Node.js, ohne Abhängigkeiten):

```bash
cd robot_bridge && npm test
```

**Dashboard** (Python, braucht Flask, also am besten mit dem Python aus `.venv`):

```bash
python -m unittest discover -s dashboard/tests
```

**Browser-Tests** (`dashboard/tests/browser-*.cjs`) brauchen `playwright-core`.
`browser-control.cjs` erwartet ein laufendes Dashboard im Modus
`bridge-simulation` und legt Screenshots und Bericht in `.demo-output/` ab.

---

## Fehlerbehebung

| Meldung | Lösung |
|---------|--------|
| `Port 5000 belongs to a different or unavailable service` | Anderen Port wählen: `--port 5001` |
| `Install Node.js 22.9 or newer` | Node.js ≥ 22.9 installieren (nur für Bridge-Modi nötig) |
| `Create .robot-local.json from robot-config.example.json …` | `prepare-robot.ps1` ausführen |
| `Robot MAC does not match this address on this network` | Bellas IP hat sich geändert. Aktuelle IP in Bellas WLAN-Einstellungen nachsehen, Vorbereitung wiederholen. |
| `The local listener certificate is missing, expired …` | Zertifikat ist abgelaufen (7 Tage) oder die Laptop-IP hat sich geändert: `prepare-robot.ps1` erneut ausführen |
| `The existing robot service is read-only` | Laufende Read-only-Bridge in ihrem Terminal stoppen, dann `live` starten |
| `Start --drive in a terminal …` | `live` nur direkt im Terminal starten, nicht im Hintergrund |

---

## Dokumentation

| Datei | Inhalt |
|-------|--------|
| [`docs/notes.md`](docs/notes.md) | Funktionsweise, Zustände, Karte, Zielauswahl, Netzwerk und Port-Scan |
| [`docs/research.md`](docs/research.md) | Wege zum Programmieren: Cloud API, Private Cloud, PUDU OS SDK |
| [`docs/jailbreak-log.md`](docs/jailbreak-log.md) | Forschungs-Tagebuch zu Jailbreaking/Rooting |
| [`dashboard/README.md`](dashboard/README.md) | Aufbau, Modi und API des Dashboards |
| [`robot_bridge/README.md`](robot_bridge/README.md) | Aufruf, Einrichtung, Ports und Sicherheitsregeln der Robot Bridge |

---

## Grundsätze

- **Verstehen, nicht erzwingen:** kein Rooting oder Jailbreaking, nur offizielle
  bzw. vom Operator freigegebene Schnittstellen.
- Nur dieser Roboter, nur unser Netzwerk, nur mit OK der Betreuungsperson.
- Keine Passwörter, Keys oder Zertifikate ins Repo.
