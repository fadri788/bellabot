# Research: Exploring ways to program Pudu

**Aufgabe 2** – Wie kann man den BellaBot per Code steuern?

Quellen:
- [PUDU Open Platform – Cloud API](https://open.pudutech.com/en/cloud-api)
- [PUDU Skill (GitHub)](https://github.com/pudu-robotics/skills) – offizielle API-Beschreibung für AI-Coding-Tools
- [PUDU Academy – BellaBot Operation Guide](https://academy.pudutech.com/en/docs/bei-la-cao-zuo-zhi-nan)

---

## Überblick: Drei Wege zum Programmieren

| Weg | Wo läuft der Code? | Wofür? |
|---|---|---|
| **PUDU Cloud API** | Auf unserem PC/Server, Anfragen gehen über Pudus Cloud | Aufträge senden, Status lesen, Statistiken – das ist unser Fokus |
| **PUDU Private Cloud API** | Eigener Server beim Kunden | Für Firmen mit eigener, isolierter Installation |
| **PUDU OS SDK** | Direkt auf dem Roboter (Android) | Eigene Apps und Plugins auf dem Display |

Die Cloud API ist eine **REST-API**: Man schickt HTTPS-Anfragen (GET/POST) mit JSON und bekommt JSON zurück. Der Roboter wird über die Pudu-Cloud angesprochen, nicht direkt über das lokale WLAN.

---

## 1. Was kann man dem Roboter befehlen?

| Bereich | Beispiele | Endpoint (Auszug) |
|---|---|---|
| **Robot information** | Status, Akku, Position, aktueller Auftrag | `GET /open-platform-service/v2/status/get_by_sn` |
| **Robot task** | Lieferauftrag senden, Transport, Cruise, Roboter rufen | `POST /open-platform-service/v1/delivery_task`, `POST /open-platform-service/v1/cruise_task`, `POST /open-platform-service/v1/custom_call` |
| **Control command** | Pausieren/fortsetzen/abbrechen, zur Ladestation schicken, Karte wechseln | `POST /open-platform-service/v1/delivery_action`, `GET /open-platform-service/v2/recharge`, `POST /open-platform-service/v1/switch_map` |
| **Medien** | Sprachansage