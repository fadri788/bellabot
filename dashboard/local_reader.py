"""Read the existing laptop monitor without opening a robot connection."""

from datetime import datetime, timezone
import json
import math
from threading import RLock
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def read_monitor():
    opener = build_opener(ProxyHandler({}), NoRedirect())
    with opener.open("http://127.0.0.1:3443/state", timeout=1.5) as response:
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Monitor response is too large")
        return json.loads(raw)


class LocalRobotReader:
    def __init__(self, known_points, reader=read_monitor, clock=None):
        self.known_points = known_points
        self.reader = reader
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.notice = None
        self.lock = RLock()

    def _snapshot(self):
        try:
            value = self.reader()
            if not isinstance(value, dict) or value.get("source") != "local-robot":
                return None
            if value.get("simulated") is True or not all(
                value.get(key) is True for key in ("connected", "registered", "fresh")
            ):
                return None
            observed = datetime.fromisoformat(value["statusAt"].replace("Z", "+00:00"))
            if not 0 <= (self.clock() - observed).total_seconds() < 18:
                return None
            if not isinstance(value.get("status"), dict):
                return None
            return value
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            return None

    def status(self):
        with self.lock:
            snapshot = self._snapshot()
            if snapshot is None:
                return {"battery": "--", "state": "offline",
                        "task": "Nur Anzeige: keine frischen Roboterdaten",
                        "mode": "read-only", "simulated": False}
            status = snapshot["status"]
            battery = status.get("robotPower")
            if type(battery) not in (int, float) or not math.isfinite(battery) or not 0 <= battery <= 100:
                battery = "--"
            else:
                battery = round(battery)
            move_state = status.get("moveState")
            state = {"Idle": "idle", "Moving": "moving", "Arrive": "arrived"}.get(
                move_state if isinstance(move_state, str) else "", "unknown"
            )
            if status.get("chargeStage") == "Charging":
                state = "charging"
            elif move_state == "Idle" and status.get("robotState") == "Busy":
                state = "busy"
            task = "Roboter meldet Busy. Aufgabe am Roboter prüfen." if state == "busy" else "Live-Daten, nur Anzeige"
            return {"battery": battery, "state": state,
                    "task": self.notice or task,
                    "mode": "read-only", "simulated": False}

    def points(self):
        with self.lock:
            snapshot = self._snapshot()
            if snapshot is None or snapshot.get("mapPending") is not False:
                return []
            atlas = snapshot.get("map")
            destinations = snapshot.get("destinations")
            if not isinstance(atlas, dict) or not isinstance(atlas.get("elements"), list) or not isinstance(destinations, list):
                return []
            sources = [item.get("name") for item in atlas["elements"]
                       if isinstance(item, dict) and item.get("type") == "source"]
            names = [item.get("name") for item in destinations if isinstance(item, dict)]
            return [point for point in sources if isinstance(point, str) and 0 < len(point) <= 128
                    and not any(ord(char) < 32 or ord(char) == 127 for char in point)
                    and sources.count(point) == 1 and names.count(point) == 1]

    def start_delivery(self, point):
        with self.lock:
            self.notice = "Keine Fahrt gesendet: nur Anzeige"
            return {"ok": False, "message": self.notice, "sentToRobot": False}

    def command(self, action):
        with self.lock:
            label = "Pause" if action == "pause" else "Rückkehr"
            self.notice = f"{label} nicht gesendet: nur Anzeige"
            return {"ok": False, "message": self.notice, "sentToRobot": False}
