"""
Mock-Server fuers BellaBot-Dashboard
Endpoints sind wie die echte Cloud-API geformt:
  GET  /robot/status   -> { battery, state, task }
  POST /task/delivery  -> startet eine Lieferung zu einem Punkt
  POST /command        -> pause / return
"""

from flask import Flask, jsonify, request, send_from_directory
import time

# --- KONFIGURATION (spaeter fuer "live" anpassen) ---
USE_MOCK = True
ROBOT_BASE_URL = "http://10.55.74.22"
ROBOT_KEY = "DEIN_API_KEY_HIER"

# Deine Karten-Punkte
MAP_POINTS = [
    "3D Printer", "Avatar", "VR", "Accenture Robot", "Kitchen",
    "Meeting", "Printer", "Table2", "Tables", "Trash", "TV", "WC"
]

# Wie lange jede Phase dauert (Sekunden)
DELIVER_SECS = 8
RETURN_SECS  = 8
CHARGE_SECS  = 10


class MockRobot:
    def __init__(self):
        self.battery = 92.0
        self.state = "idle"
        self.task = "-"
        self.queue = []            # geplante Phasen mit Endzeit
        self.last = time.time()

    def _tick(self):
        """Laeuft bei jedem Status-Abruf: Phasen weiterschalten + Akku anpassen."""
        now = time.time()
        elapsed = now - self.last
        self.last = now

        # Abgelaufene Phasen entfernen
        while self.queue and now >= self.queue[0]["ends"]:
            self.queue.pop(0)

        if self.queue:
            self.state = self.queue[0]["state"]
            self.task = self.queue[0]["task"]
        elif self.state not in ("idle", "paused"):
            # Alle Phasen fertig -> zurueck auf idle
            self.state = "idle"
            self.task = "-"

        # Akku: sinkt beim Fahren, steigt beim Laden
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
            return {"ok": True, "message": "Pausiert"}
        if action == "return":
            self.queue = [
                {"state": "returning", "task": "Zurueck zur Basis", "ends": now + RETURN_SECS},
                {"state": "charging",  "task": "Laedt an der Basis", "ends": now + RETURN_SECS + CHARGE_SECS},
            ]
            self.last = now
            return {"ok": True, "message": "Kehrt zur Basis zurueck"}
        return {"ok": False, "message": "Unbekannter Befehl"}


robot = MockRobot()
app = Flask(__name__)

# --- Webseite ---
@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(".", filename)

# --- API (wie die echte Cloud-API geformt) ---
@app.route("/robot/status")
def robot_status():
    return jsonify(robot.status())

@app.route("/points")
def points():
    return jsonify({"points": MAP_POINTS})

@app.route("/task/delivery", methods=["POST"])
def task_delivery():
    point = request.json.get("point", "")
    if point not in MAP_POINTS:
        return jsonify({"ok": False, "message": "Unbekannter Punkt"}), 400
    return jsonify(robot.start_delivery(point))

@app.route("/command", methods=["POST"])
def command():
    action = request.json.get("action", "")
    return jsonify(robot.command(action))


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)