"""
Mock-Server fuers BellaBot-Dashboard
Endpoints wie die echte Cloud-API:
  GET  /robot/status   -> { battery, state, task }
  GET  /points         -> { points: [...] }
  POST /task/delivery  -> startet eine Lieferung zu einem Punkt
  POST /command        -> pause / return
"""

from flask import Flask, jsonify, request, send_from_directory
import time

# --- KONFIGURATION (spaeter fuer "live" anpassen) ---
USE_MOCK = True
ROBOT_BASE_URL = "http://10.55.74.22"
ROBOT_KEY = "DEIN_API_KEY_HIER"

MAP_POINTS = [
    "3D Printer", "Avatar", "VR", "Accenture Robot", "Kitchen",
    "Meeting", "Printer", "Table2", "Tables", "Trash", "TV", "WC"
]

DELIVER_SECS = 8
RETURN_SECS  = 8
CHARGE_SECS  = 10


class MockRobot:
    def __init__(self):
        self.battery = 92.0
        self.state = "idle"
        self.task = "-"
        self.queue = []
        self.last = time.time()

    def _tick(self):
        now = time.time()
        elapsed = now - self.last
        self.last = now

        while self.queue and now >= self.queue[0]["ends"]:
            self.queue.pop(0)

        if self.queue:
            self.state = self.queue[0]["state"]
            self.task = self.queue[0]["task"]
        elif self.state not in ("idle", "paused"):
            self.state = "idle"
            self.task = "-"

        if self.state in ("delivering", "returning"):
            self.battery = max(0, self.battery - elapsed * 0.3)
        elif self.state == "charging":
            self.battery = min(100, self.battery + elapsed * 1.0)

    def status(self):
        self._tick()
        return {
            "battery": round(self.battery),
            "state": self.state,
            "task": self.task,
        }

    def start_delivery(self, point):
        now = time.time()
        self.queue = [
            {"state": "delivering", "task": f"Unterwegs zu: {point}", "ends": now + DELIVER_SECS},
            {"state": "returning",  "task": "Zurueck zur Basis",      "ends": now + DELIVER_SECS + RETURN_SECS},
            {"state": "charging",   "task": "Laedt an der Basis",     "ends": now + DELIVER_SECS + RETURN_SECS + CHARGE_SECS},
        ]
        self.last = now
        return {"ok": True, "message": f"Lieferung zu {point} gestartet"}

    def command(self, action):
        now = time.time()
        if action == "pause":
            self.queue = []
            self.state = "paused"
            self.task = "Pausiert"
            return {"ok": True, "message":