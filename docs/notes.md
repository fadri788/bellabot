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
| **BellaBot** | **10.55.74.22** | **20:50:e7:40:33:4c** | Hostname `Android.local` (mDNS) → läuft auf Android. Antwortet nicht auf ICMP-Ping. |

### Port-Scan
- Tool: nmap 7.80
- Befehl (alle Ports): `nmap -Pn -p- -T4 10.55.74.22`  → ca. 228 s
- Befehl (Dienst-Erkennung): `nmap -Pn -sV -p 8080 10.55.74.22`  → ca. 137 s

| Port | Protokoll | Status | Dienst            | Bemerkung |
|------|-----------|--------|-------------------|-----------|
| 8080 | tcp       | open   | HTTP (Webserver)  | Titel der Seite: "Android Debug Database" (Library von Amit Shekhar). Alle anderen 65'534 Ports: closed. |

**Erkenntnis:**
- Der Roboter läuft auf Android (Hostname `Android.local`).
- Einziger offener Port: 8080. Kein SSH (22), kein ADB (5555).
- Auf 8080 antwortet ein Webserver namens "Android Debug Database" — ein Entwickler-Tool zum Ansehen der App-Datenbank. Antwortet mit HTTP 200.

## Jailbreaking / Rooting

### Begriffe
- **Rooting:** Sich auf einem Android- oder Linux-Gerät die höchsten Rechte verschaffen
  ("root" = Administrator). Man darf dann alles: Systemdateien ändern, Apps entfernen,
  Sicherheitssperren umgehen.
- **Jailbreaking:** Dasselbe Prinzip, der Begriff kommt von Apple-Geräten (iPhone).
  Man "bricht aus dem Gefängnis" der Herstellerbeschränkungen aus.
- Beides nutzt meist Sicherheitslücken oder entsperrt den Bootloader.

### Bezug zum BellaBot
- Der BellaBot läuft auf Android/Linux (PUDU OS). Rooting wäre also technisch denkbar.
- Pudu bietet offizielle Wege an: Cloud API und PUDU OS SDK. Dafür braucht es kein Rooting.

### Warum wir das NICHT machen
- **Garantie und Support weg:** Pudu hilft nicht mehr, wenn etwas kaputtgeht.
- **Risiko "Brick":** Der Roboter kann unbrauchbar werden (Karten, Navigation, Sicherheit).
- **Sicherheit:** Notaus, Hinderniserkennung und Tempo-Grenzen könnten beeinträchtigt werden.
  Er fährt zwischen Menschen herum.
- **Rechtlich und vertraglich:** Das Gerät gehört nicht uns. Lizenzbedingungen und
  Firmenregeln verbieten so etwas meistens.
- **Updates:** Offizielle Firmware-Updates funktionieren danach oft nicht mehr.

### Fazit
Ich weiss, was Rooting/Jailbreaking ist, und halte mich an die offiziellen Schnittstellen
(Cloud API / SDK). Im Leitfaden steht: "verstehen, nicht erzwingen".