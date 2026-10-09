"""Dashboard adapter for the bundled, supervised local control service."""

from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
from threading import RLock
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler
from uuid import UUID

from local_reader import NoRedirect


def bridge_request(path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = Request("http://127.0.0.1:3443" + path, data=data,
                      headers={} if data is None else {"Content-Type": "application/json"})
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        response = opener.open(request, timeout=3)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Bridge response too large")
        return response.status, json.loads(raw)


def timestamp(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError, AttributeError):
        return float("nan")


class GatedRobot:
    def __init__(self, simulated=False, transport=bridge_request, lock_path=None, clock=None):
        self.simulated = simulated
        self.mode = "bridge-simulation" if simulated else "live"
        self.transport = transport
        self.clock = clock or (lambda: datetime.now(timezone.utc).timestamp())
        self.lock = RLock()
        self.lock_path = Path(lock_path) if lock_path else None
        self.pending = None
        if self.lock_path and self.lock_path.exists():
            try:
                self.pending = json.loads(self.lock_path.read_text(encoding="utf-8"))
                if self.pending is not None and (not isinstance(self.pending, dict)
                    or type(self.pending.get("at")) not in (int, float) or not math.isfinite(self.pending["at"])):
                    raise ValueError("Invalid command record")
            except (OSError, ValueError):
                self.pending = {"at": float("inf"), "damaged": True}

    def _snapshot(self):
        code, value = self.transport("/state")
        if code != 200 or not isinstance(value, dict) or value.get("source") != "local-robot" or value.get("bridgeProtocol") != "bellabot-dashboard-v1":
            raise ValueError("Lokaler Roboterdienst nicht verfügbar")
        if value.get("simulated", False) is not self.simulated or (not self.simulated and value.get("identityVerified") is not True):
            raise ValueError("Roboterdienst hat nicht den erwarteten Modus oder die bestätigte Identität")
        age = self.clock() - timestamp(value.get("statusAt"))
        if not all(value.get(key) is True for key in ("connected", "registered", "fresh")) or not 0 <= age < 18:
            raise ValueError("Keine frische Verbindung zum Roboter")
        if not isinstance(value.get("status"), dict) or not isinstance(value.get("control"), dict):
            raise ValueError("Roboterdaten sind unvollständig")
        atlas = value.get("map")
        active = value["control"].get("active")
        if (atlas is not None and (not isinstance(atlas, dict) or not isinstance(atlas.get("elements"), list))) or not isinstance(value.get("destinations"), list):
            raise ValueError("Kartendaten sind unvollständig")
        if active is not None and (not isinstance(active, dict) or not isinstance(active.get("destination"), dict)):
            raise ValueError("Aufgabendaten sind unvollständig")
        return value

    def _points(self, snapshot):
        atlas = snapshot.get("map") or {}
        if snapshot.get("mapPending") is not False or not 0 <= self.clock() - timestamp(snapshot.get("mapAt")) <= 120:
            return []
        sources = [item.get("name") for item in atlas.get("elements", []) if isinstance(item, dict) and item.get("type") == "source"]
        destinations = [item.get("name") for item in snapshot.get("destinations", []) if isinstance(item, dict)]
        return [name for name in sources if isinstance(name, str) and 0 < len(name) <= 128
                and not any(ord(char) < 32 or ord(char) == 127 for char in name)
                and sources.count(name) == 1 and destinations.count(name) == 1]

    def points(self):
        with self.lock:
            try:
                return self._points(self._snapshot())
            except (OSError, ValueError, TypeError, KeyError):
                return []

    def status(self):
        with self.lock:
            base = {"mode": self.mode, "simulated": self.simulated, "canGo": False,
                    "canCancel": False, "canReconcile": False, "canReturn": False, "mapId": None}
            try:
                snapshot = self._snapshot()
                status, control = snapshot["status"], snapshot["control"]
                active = control.get("active") or {}
                phase = active.get("phase")
                name = (active.get("destination") or {}).get("name")
                settled = status.get("robotState") == "Free" and status.get("moveState") == "Idle" and status.get("chargeStage") == "Idle"
                points = self._points(snapshot)
                enabled = control.get("enabled") is True and not control.get("busy") and not control.get("storageFault")
                can_go = enabled and control.get("ready") is True and not active and not self.pending and bool(points)
                can_check = enabled and settled and timestamp(snapshot.get("statusAt")) > max(
                    timestamp(active.get("issuedAt")) if active else float("-inf"), self.pending["at"] if self.pending else float("-inf"))
                can_check = bool(can_check and (self.pending or phase in ("Arrived", "Cancel", "check-robot", "unknown")))
                battery = status.get("robotPower")
                battery = round(battery) if type(battery) in (int, float) and math.isfinite(battery) and 0 <= battery <= 100 else "--"
                move = status.get("moveState")
                state = "idle" if settled else "moving" if move == "Moving" else "unknown"
                if move == "Idle" and status.get("robotState") == "Busy":
                    state = "busy"
                if status.get("chargeStage") == "Charging":
                    state = "charging"
                if move == "Moving" and name:
                    state = "returning" if name == snapshot.get("returnDestination") else "delivering"
                prefix = "Simulation" if self.simulated else "Bella"
                task = f"{prefix}: bereit" if can_go else f"{prefix}: wartet auf Freigabe oder frische Kartendaten"
                if state == "busy":
                    task = f"{prefix}: belegt. Aufgabe am Roboter prüfen."
                if active:
                    task = f"Ziel: {name or '-'} ({phase or 'offen'})"
                if phase == "Arrived":
                    task = f"Ankunft gemeldet: {name}. Position prüfen."
                if self.pending or phase == "unknown":
                    task = "Ergebnis unklar. Nicht erneut senden. Aufgabe am Roboter prüfen."
                return {**base, "battery": battery, "state": state, "task": task, "destination": name,
                        "mapId": (snapshot.get("map") or {}).get("id"), "canGo": can_go,
                        "canCancel": bool(enabled and not self.pending and active.get("kind") == "call" and phase in ("accepted", "Arriving")),
                        "canReconcile": can_check, "canReturn": bool(can_go and snapshot.get("returnDestination") in points),
                        "returnDestination": snapshot.get("returnDestination")}
            except (OSError, ValueError, TypeError, KeyError):
                return {**base, "battery": "--", "state": "offline", "task": "Keine frische Verbindung zum passenden Roboterdienst"}

    def _save_pending(self, value):
        if self.lock_path:
            try:
                self.lock_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.lock_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(value), encoding="utf-8")
                os.replace(temporary, self.lock_path)
            except OSError:
                self.pending = {"at": float("inf"), "damaged": True}
                raise
        self.pending = value

    def _send(self, action, body, point=None):
        with self.lock:
            attempted = False
            previous_pending = self.pending
            try:
                request_id = body.get("id")
                if not isinstance(request_id, str) or str(UUID(request_id)) != request_id:
                    raise ValueError("Eine neue Anfrage-ID ist erforderlich")
                confirmation = body.get("confirmation")
                if not isinstance(confirmation, dict) or not all(confirmation.get(key) is True for key in
                    ("besideRobot", "correctMapAndPosition", "clearPathAndStopReady")):
                    raise ValueError("Bediener, Karte, Position, freie Strecke und Stopptaste bestätigen")
                if action == "reconcile" and confirmation.get("robotTaskCleared") is not True:
                    raise ValueError("Zuerst die Aufgabe auf dem Roboter prüfen und leeren")
                snapshot = self._snapshot()
                map_id = (snapshot.get("map") or {}).get("id")
                if not map_id or body.get("mapId") != map_id:
                    raise ValueError("Die Karte hat sich geändert. Neu prüfen und bestätigen.")
                if self.pending:
                    if action != "reconcile" or not self.status()["canReconcile"]:
                        raise ValueError("Vor einer neuen Anfrage das unklare Ergebnis am Roboter prüfen")
                    if not snapshot["control"].get("active"):
                        self._save_pending(None)
                        return {"ok": True, "message": "Lokale Sperre nach Bedienerprüfung aufgehoben. Keine Fahrt gesendet."}
                payload = {"id": request_id, "action": action, "mapId": map_id, "confirmation": confirmation}
                if action == "go":
                    if point not in self._points(snapshot):
                        raise ValueError("Ziel ist nicht eindeutig auf der aktuellen Karte")
                    payload["destination"] = point
                self._save_pending({"id": request_id, "at": self.clock(), "action": action})
                try:
                    attempted = True
                    code, result = self.transport("/api/local/control", payload)
                except (OSError, ValueError, TypeError):
                    return {"ok": False, "message": "Ergebnis unklar. Nicht erneut senden. Roboter prüfen.", "outcome": "unknown"}
                if not isinstance(result, dict) or code >= 500:
                    return {"ok": False, "message": "Ergebnis unklar. Roboter prüfen.", "outcome": "unknown"}
                if code >= 400:
                    self._save_pending(previous_pending)
                    return {"ok": False, "message": str(result.get("error", "Anfrage abgelehnt"))[:500]}
                if code != 202 or result.get("outcome") not in ("pending", "accepted", "rejected", "local-only"):
                    return {"ok": False, "message": "Antwort unklar. Roboter prüfen.", "outcome": "unknown"}
                self._save_pending(None)
                return {"ok": result.get("outcome") != "rejected", "outcome": result.get("outcome"),
                        "message": "Aufgabe lokal freigegeben." if action == "reconcile" else "Anfrage einmal gesendet. Status und Roboter beobachten."}
            except (OSError, ValueError, TypeError, KeyError):
                if attempted:
                    return {"ok": False, "message": "Ergebnis oder Speicherung unklar. Nicht erneut senden. Roboter prüfen.", "outcome": "unknown"}
                return {"ok": False, "message": "Anfrage nicht gesendet. Verbindung, Karte und Bedienerbestätigung prüfen."}

    def start_delivery(self, point, body):
        return self._send("go", body, point)

    def command(self, action, body):
        if action == "return":
            try:
                point = self._snapshot().get("returnDestination")
            except (OSError, ValueError, TypeError):
                point = None
            if not point:
                return {"ok": False, "message": "Kein bestätigter Rückkehrpunkt eingerichtet"}
            return self._send("go", body, point)
        if action in ("cancel", "reconcile"):
            return self._send(action, body)
        return {"ok": False, "message": "Pause ist hier nicht verfügbar. Abbrechen ist ein eigener Befehl."}
