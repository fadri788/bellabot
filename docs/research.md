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
| **Medien** | Sprachansage abspielen, Lautstärke | `POST /open-platform-service/v1/voice/play`, `POST /open-platform-service/v1/volume/set` |
| **Robot Scheduling** | Ablauf von Aufträgen (welches Ziel wann erreicht) | `GET /data-board/v1/task/delivery` |
| **Statistical data** | Anzahl Lieferungen, Laufzeit, Übersicht pro Store | `GET /data-board/v1/brief/run`, `GET /data-board/v1/analysis/run` |
| **Karten** | Kartenliste, Punkte (z. B. «kitchen», «table 2») | `GET /data-open-platform-service/v1/api/maps` |

Zu jedem Auftragstyp gibt es einen `*_action`-Endpoint zum **Pausieren, Fortsetzen oder Abbrechen**.

Beispiel: Lieferauftrag an «table 2» (vereinfacht):

```json
POST /open-platform-service/v1/delivery_task
{
  "sn": "SERIENNUMMER-DES-ROBOTERS",
  "payload": {
    "type": "NEW",
    "trays": [
      { "destinations": [ { "points": "table 2" } ] }
    ]
  }
}
```

> Hinweis: Die genauen Feldwerte (z. B. `type`) muss man in der offiziellen Doku prüfen. Man braucht die **SN (Seriennummer)** des Roboters, nicht die MAC-Adresse.

---

## 2. Wie funktioniert das Login?

Es gibt **kein Login mit Benutzername und Passwort**. Stattdessen bekommt man von Pudu zwei Werte:

| Wert | Bedeutung |
|---|---|
| **ApiAppKey** | Öffentliche ID der Anwendung («wer bin ich?») |
| **ApiAppSecret** | Geheimer Schlüssel, wird **nie mitgeschickt** |

Jede Anfrage wird **signiert** (Verfahren: **HMAC-SHA1**):

1. Aus Datum (`x-date`), HTTP-Methode, Content-Type, `Content-MD5` (Hash des Bodys bei POST) und Pfad wird ein Text gebaut.
2. Dieser Text wird mit dem **ApiAppSecret** per HMAC-SHA1 verschlüsselt und Base64-codiert → das ist die **Signatur**.
3. Die Signatur kommt mit dem ApiAppKey in den Header:

```
Authorization: hmac id="<ApiAppKey>", algorithm="hmac-sha1", headers="x-date", signature="<Signatur>"
```

Der Pudu-Server rechnet die Signatur mit seiner Kopie des Secrets nach. Stimmt sie, ist die Anfrage echt und unverändert.

Fehler: **HTTP 401** = Signatur falsch, **403** = Endpoint nicht freigeschaltet.

**Sicherheit:** Key und Secret gehören in **Umgebungsvariablen**, niemals in den Code oder auf GitHub.

---

## 3. Was braucht man, um «live» zu gehen?

1. **Account** auf der Pudu Händler-/Merchant-Plattform.
2. **Roboter binden und aktivieren**.
3. **API-Zugangsdaten** (ApiAppKey + ApiAppSecret) beantragen.
4. **Richtigen Cluster** wählen:

| Cluster | Region | Host |
|---|---|---|
| `cn` | China | `open-platform.pudutech.com` |
| `sea` | Japan/Korea/Singapur | `css-open-platform.pudutech.com` |
| `de` | Deutschland (vermutlich für uns) | `csg-open-platform.pudutech.com` |
| `us` | USA | `csu-open-platform.pudutech.com` |

5. Auf dem Roboter unter **Settings → Advanced Settings** die Option **Robot API** aktivieren.
6. Der Roboter muss **online** sein.

> **Wichtig:** WLAN allein reicht nicht. Ohne Key und Secret lehnt die Cloud jede Anfrage ab. Deshalb arbeiten wir vorerst mit einem **Mock**.

---

## 4. Welche Daten liefert der Roboter zurück?

Alle Antworten sind **JSON**. Erfolgreich ist eine Anfrage nur bei **HTTP 200** und `"message": "SUCCESS"`.

Beispiel Status:

```json
{
  "message": "SUCCESS",
  "data": {
    "sn": "SERIENNUMMER",
    "runState": "IDLE",
    "battery": 58,
    "isCharging": 0,
    "moveState": "...",
    "remainTime": 0
  }
}
```

| Datenart | Inhalt |
|---|---|
| **Status** | `runState`: `OFFLINE`, `DISABLE`, `BUSY`, `IDLE` |
| **Akku** | `battery` (%), `isCharging`, `chargeStage`, `remainTime` |
| **Position** | `mapName`, `floor`, `x`, `y`, `yaw` |
| **Auftrag** | `taskId`, Zustand, Ziele |
| **Statistik** | Lieferungen, Laufzeit, Rufe pro Store/Roboter |
| **Logs** | Selbsttest, Ladevorgänge, Fehler |
| **Callback notification** | Pudu schickt bei Änderungen selbst eine POST-Anfrage an unsere URL (**Webhook**), statt dass wir ständig nachfragen. |

---

## Fazit

- Steuerung per Code ist über die **PUDU Cloud API** möglich.
- Login über **ApiAppKey + ApiAppSecret** mit **HMAC-SHA1-Signatur**.
- Für den Live-Betrieb: **Account, gebundener Roboter, Zugangsdaten, Cluster, Robot API aktiviert**.
- Bis wir die Zugangsdaten haben, testen wir mit einem **Mock**.