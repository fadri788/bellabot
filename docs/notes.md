# BellaBot – Übersicht

## Funktionsweise

Der BellaBot scannt den Raum mit **Laser und Kameras** und erstellt daraus eine Karte. Damit findet er selbstständig zu den Tischen. **Sensoren** lassen ihn Hindernissen ausweichen und schützen ihn davor, Treppen hinunterzufallen. Das Personal wählt am **Display** den Tisch aus, und wenn der Akku schwach ist, fährt er von selbst zur **Ladestation**.

## Zustände

| Zustand | Beschreibung |
|---|---|
| **Idle / Standby** | Wartet am Abholpunkt auf einen Auftrag. |
| **Charging** | Steht an der Ladestation oder hängt am Kabel. |
| **Returning** | Fährt nach einem Auftrag zurück. |
| **Paused** | Wurde angetippt oder ist blockiert und wartet. |
| **Sleep** | Spart Strom, wenn er länger nichts tut. |
| **Emergency Stop** | Der rote Notaus-Knopf ist gedrückt, die Motoren sind aus. |

## Karte

Die Karte zeigt die Fahrwege des BellaBots aus der Vogelperspektive. Die grauen Linien sind die Routen, auf denen er sich bewegen darf, nicht die Wände des Raums.

Der Bereich ist ungefähr rechteckig und leicht schräg. Eine Linie in der Mitte teilt ihn in zwei Zonen, sodass der Roboter auch quer abkürzen kann. Kurze Abzweigungen links und oben führen vermutlich zu Tischen oder Haltepunkten. Unten rechts gibt es eine kleine Schlaufe mit einem Ausläufer, wahrscheinlich der Bereich der Ladestation oder des Abholpunkts.

Unter der Karte kann man den **Startpunkt** auswählen, von dem aus der Roboter seine Fahrt beginnt.
## Zielauswahl

Auf diesem Bildschirm wählt man aus, wohin der BellaBot fahren soll. Die Ziele sind auf der Karte als Haltepunkte gespeichert:

| Ziel | Ziel | Ziel |
|---|---|---|
| 3d printer | Avatar | VR |
| accenture robot | kitchen | meeting |
| printer | table 2 | tables |
| trash | tv | wc |

Nach der Auswahl eines oder mehrerer Ziele drückt man auf **Start!** und der Roboter fährt los.

Rechts befinden sich zusätzliche Funktionen:
- **Sprechblase:** Sprachansagen bzw. Texte, die der Roboter abspielt
- **Uhr:** Aufträge zeitlich planen
- **Zahnrad:** Einstellungen
- **Musiknote:** Musik während der Fahrt

Oben rechts sieht man den Status (**Busy**), die WLAN-Verbindung und den Akkustand (58 %).

## Teil 4 · Netzwerk-Setup

**Datum:** 2026-10-05
**Netzwerk:** Handy-Hotspot (Passwort nicht im Repo)

| Gerät   | IP            |
|---------|---------------|
| Laptop  | 172.20.10.x   |
| Roboter | 172.20.10.x   |

Gegenprüfung in den Roboter-WLAN-Einstellungen: ✅ / ❌

### Offene Ports (Roboter)
| Port | Dienst (nmap -sV) | Bemerkung |
|------|-------------------|-----------|
|      |                   |           |

**Tool:** Angry IP Scanner (Version …) / nmap
**Probleme:** …

## Port-Scan BellaBot

- Datum: 2026-10-06
- Netz: Handy-Hotspot
- Roboter-IP: <IP>
- Befehl: `nmap -Pn -p- -T4 <IP>` + `nmap -sV -p <ports> <IP>`

| Port | Protokoll | Dienst (nmap) | Version | Bemerkung / Idee |
|------|-----------|---------------|---------|------------------|
| 22   | tcp       | ssh           | …       | Login nötig?     |
| …    | …         | …             | …       | …                |

### Port-Scan
- Tool: nmap 7.80 (Angry IP Scanner war für 1 Host zu langsam)
- Befehl: `nmap -Pn -p- -T4 10.55.74.22`
- Dauer: ca. 228 Sekunden, alle 65'535 TCP-Ports

| Port | Protokoll | Status | Dienst (nmap-Vermutung) | Bemerkung / Idee |
|------|-----------|--------|-------------------------|------------------|
| 8080 | tcp       | open   | http-proxy              | Einziger offener Port → vermutlich Web-Oberfläche oder HTTP-API des Roboters. Mit `-sV` und Browser genauer prüfen. |

**Erkenntnis:** Alle anderen 65'534 Ports sind *closed* (nicht *filtered*).
Kein SSH (22), kein ADB (5555) offen → der einzige Zugang übers Netz ist Port 8080.