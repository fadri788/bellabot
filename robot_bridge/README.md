# Robot Bridge

Lokaler Node.js-Dienst zwischen dem [Dashboard](../dashboard/README.md) und
Bella. Er hört auf dem Laptop zu, wenn sich der Roboter über seine *Local API*
meldet (MQTT 3.1.1 über TLS), liest Status, Ziele und Karte und leitet geprüfte
Fahrbefehle weiter.

> ⚠️ Fahrten nur mit einer Person direkt neben Bella und dem Notaus-Knopf in
> Reichweite.

## Aufruf

```bash
node robot_bridge/index.js [--simulate | --drive] [--check]
```

| Option       | Wirkung                                                                 |
|--------------|-------------------------------------------------------------------------|
| *(keine)*    | **Read-only:** verbindet sich mit Bella und liest nur, keine Befehle    |
| `--simulate` | Kein Roboter, simulierte Ziele `Kitchen`, `VR`, `Base`                  |
| `--drive`    | Beaufsichtigte Fahrten. Fragt im Terminal nach `DRIVE`, bevor Befehle erlaubt sind |
| `--check`    | Prüft nur die Einrichtung (Konfiguration, Roboter-Identität, Zertifikat), startet nichts |

Normalerweise startet man die Bridge nicht selbst, sondern über
`start_demo.py --mode bridge-simulation | read-only | live` im Hauptordner.

Voraussetzung: **Node.js ≥ 22.9**. Es gibt keine npm-Abhängigkeiten.

## Ports

| Adresse                | Wer verbindet sich      | Zweck                                       |
|------------------------|-------------------------|---------------------------------------------|
| `127.0.0.1:3443`       | Dashboard (`gated_robot.py`, `local_reader.py`) | Zustand lesen und Befehle senden (HTTP) |
| `<Laptop-IP>:8443`     | Bella                   | Local API des Roboters (MQTT über TLS)      |

## Einrichtung für den echten Roboter

Die Bridge braucht zwei lokale Dateien, die **nicht** ins Repo gehören
(beide stehen in `.gitignore`):

- `.robot-local.json`: Laptop-IP, Roboter-IP, Roboter-MAC und optional der
  Rückkehrpunkt (Aufbau wie `robot-config.example.json`)
- `.robot-runtime/listener-certificate.json`: selbst signiertes Zertifikat für
  den TLS-Listener auf Port 8443

Beides erstellt `prepare-robot.ps1` (PowerShell ≥ 7.2, unter Windows als
Administrator):

```bash
pwsh robot_bridge/prepare-robot.ps1 -LaptopIp <LAPTOP-IP> -RobotIp <ROBOTER-IP> -RobotMac <ROBOTER-MAC> -ReturnDestination <ZIEL>
```

Mit `-DryRun` zeigt das Skript nur an, was es tun würde. Ohne `-DryRun` macht es Folgendes:

1. prüft, ob beide Adressen private IPv4-Adressen sind und die MAC wirklich zu
   der Roboter-IP gehört,
2. speichert `.robot-local.json`,
3. erstellt ein Zertifikat für die Laptop-IP, das **7 Tage** gültig ist,
4. erlaubt unter Windows mit einer Firewall-Regel nur diesem Roboter den
   Zugriff auf TCP 8443. Unter anderen Systemen muss man das selbst einrichten.

Danach auf Bella (mit Erlaubnis des Operators) unter *Robot API / Local / Host*
die Laptop-IP mit Port **8443** eintragen.

**Neues Zertifikat nötig**, wenn die Bridge meldet:

- `Prepare a fresh listener certificate on this laptop.`
- `The local listener certificate is missing, expired or belongs to another laptop address.`

Dann `prepare-robot.ps1` mit den aktuellen Adressen erneut ausführen.
Das passiert, wenn 7 Tage vorbei sind oder sich die Laptop-IP geändert hat.

## HTTP-Schnittstelle (`127.0.0.1:3443`)

Nur von `127.0.0.1` erreichbar, Anfragen von fremden Seiten (Cross-Site) werden blockiert.

| Methode | Pfad                 | Wirkung                                                     |
|---------|----------------------|-------------------------------------------------------------|
| GET     | `/state`             | Zustand: Verbindung, Status, Ziele, Karte, Steuerung        |
| POST    | `/refresh`           | `{ "scope": "status" }` oder `{ "scope": "map" }` neu lesen |
| POST    | `/api/local/control` | Geprüfter Befehl: `go`, `cancel` oder `reconcile`           |

Antworten von `/state` tragen `"bridgeProtocol": "bellabot-dashboard-v1"`.
Daran erkennen Dashboard und Starter, dass auf dem Port die richtige Bridge läuft.

## Sicherheitsregeln

- Nur drei Befehle sind freigeschaltet: Fahrt zu einem **benannten Ziel**
  (`go`), **Abbrechen** (`cancel`) und **Abgleich** durch den Operator nach
  einem unklaren Ergebnis (`reconcile`).
- Vor dem Start und vor jedem Befehl prüft die Bridge in der ARP-Tabelle, ob die
  MAC zur Roboter-IP passt.
- Jeder Befehl braucht eine frische Verbindung (Status jünger als 18 s) und die
  Bestätigung des Operators: neben Bella, Karte und Position stimmen, Weg frei,
  Stopptaste bereit.
- Eine neue Fahrt zusätzlich: Bella steht still, ist frei und lädt nicht, die
  Karte ist höchstens 2 Minuten alt, das Ziel ist darauf eindeutig und es läuft
  keine andere Aufgabe.
- Eine Anfrage-ID darf nicht für einen anderen Befehl wiederverwendet werden.
  Wird dieselbe Anfrage noch einmal geschickt, kommt die alte Antwort zurück,
  ohne dass erneut gesendet wird.
- Im Live-Modus landen alle Befehle in `.robot-runtime/command-journal.json`.
- Die Sitzung endet automatisch nach **2 Stunden**.

## Aufbau

| Datei                          | Aufgabe                                                        |
|--------------------------------|----------------------------------------------------------------|
| `index.js`                     | Einstieg: Konfiguration laden, Identität prüfen, Dienste starten |
| `src/local-mqtt-observer.js`   | Kleiner MQTT-Gegenpart über TLS für genau einen Roboter        |
| `src/local-monitor.js`         | Zustand sammeln und als HTTP auf `127.0.0.1:3443` bereitstellen |
| `src/local-control.js`         | Prüft Befehle (Zustand, Karte, Bestätigung) und führt das Journal |
| `src/local-command-schema.js`  | Baut und prüft die Nachrichten für Bellas Local API            |
| `src/network.js`               | Hilfen für IP-, MAC- und ARP-Prüfung                           |
| `src/capabilities.js`          | Liste der Fähigkeiten und ihr Teststatus                       |
| `prepare-robot.ps1`            | Einrichtung: Konfiguration, Zertifikat, Firewall               |
| `test/`                        | Unit-Tests                                                     |

## Umfang und Quellen

- Unterstützt sind nur die Nachrichten in `src/local-command-schema.js`
  (`call`, `cancelCall` und die `customCall`-Varianten). Davon sind über das
  Dashboard nur Fahrt und Abbrechen erreichbar.
- Zahlenbereiche und Felder orientieren sich an der offiziellen Pudu-Doku zu
  `custom_call` (siehe `../.agents/skills/pudu-openapi-skill/references/capabilities.md`
  und [PUDU Open Platform](https://open.pudutech.com/en/cloud-api)).
- Alle Fähigkeiten in `src/capabilities.js` stehen auf `untested`. Jede Funktion
  muss auf jedem Roboter und jeder Firmware-Version zuerst beaufsichtigt
  getestet werden.

## Tests

```bash
cd robot_bridge
npm test
```
