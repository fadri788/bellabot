# BellaBot Dashboard

Web-Dashboard zum Steuern und Überwachen des Pudu BellaBot.
Läuft aktuell gegen einen **Mock** (simulierter Roboter) und kann später
ohne Umschreiben auf den echten Roboter umgestellt werden.

## Aufbau

| Datei            | Aufgabe                                             |
|------------------|-----------------------------------------------------|
| `mock_server.py` | Flask-Server: liefert die Webseite **und** die API, simuliert den Roboter |
| `index.html`     | Gerüst der Seite (Kacheln, Buttons, Punkte-Liste)   |
| `style.css`      | Aussehen (dunkles Design, Farben, Hintergrund)      |
| `app.js`         | Holt den Status und schickt Befehle an den Server   |

## Starten

```bash
pip install flask          # einmalig
cd dashboard
python mock_server.py
```

Danach im Browser öffnen: **http://127.0.0.1:5000**
(Wichtig: über den Server aufrufen, nicht die index.html direkt öffnen.)
Server stoppen: im Terminal `Strg + C`.

## Funktionen

- **Status-Kacheln:** Akku (%), Zustand, aktuelle Aufgabe – aktualisieren sich alle 2 Sekunden.
- **Steuerung:** „Zurück zur Basis“, „Pause“.
- **Punkte anfahren:** pro Karten-Punkt ein Button; Klick schickt den Roboter dorthin.
- **Farben:** Akku grün/gelb/rot je nach Ladung, Zustand je nach Status eingefärbt.

## API-Endpunkte

| Methode | Pfad          | Wirkung                          |
|---------|---------------|----------------------------------|
| GET     | `/api/status` | Akku, Zustand, Aufgabe, Punkte   |
| POST    | `/api/send`   | zu einem Punkt fahren (`{"point": "..."}`) |
| POST    | `/api/return` | zurück zur Basis                 |
| POST    | `/api/pause`  | pausieren                        |

## Später auf "live" umstellen

Nur zwei Stellen anpassen, der Rest bleibt gleich:

1. In `mock_server.py` oben: `USE_MOCK = False`, echte `ROBOT_BASE_URL` und `ROBOT_KEY` eintragen,
   und die Funktionen der Klasse so ändern, dass sie die echte Pudu-API aufrufen.
2. Die Karten-Punkte in `MAP_POINTS` müssen exakt den Namen auf der echten Karte entsprechen.

## Bekannte Stolpersteine

- `python` nicht gefunden → echtes Python von python.org installieren, Haken bei „Add to PATH“.
- Server immer aus dem Ordner `dashboard` starten, nicht über den ▶-Button (falscher Ordner).
- Dateinamen genau prüfen (`app.js`, nicht `app,js`).