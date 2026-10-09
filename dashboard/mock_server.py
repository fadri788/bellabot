from flask import Flask, jsonify, request, send_from_directory
import argparse
from pathlib import Path
from threading import RLock
import time

USE_MOCK = True
ROBOT_BASE_URL = "http://10.55.74.22"
ROBOT_KEY = "DEIN_API_KEY_HIER"

MAP_POINTS = [
    "3D Printer", "Avatar", "VR", "Accenture Robot", "Kitchen",
    "Meeting", "Printer", "Table2", "Tables", "Trash", "TV", "WC"
]

DELIVER_SECS = 8
RETURN_SECS = 8
CHARGE_SECS = 10


class MockRobot:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = RLock()
        self.battery = 92.0
        self.state = "idle"
        self.task = "-"
        self.queue = []
        self.last = self.clock()

    def _tick(self):
        now = max(self.last, self.clock())
        while self.queue:
            phase = self.queue[0]
            until = min(now, phase["ends"])
            elapsed = max(0, until - self.last)
            if phase["state"] in ("delivering", "returning"):
                self.battery = max(0, self.battery - elapsed * 0.3)
            elif phase["state"] == "charging":
                self.battery = min(100, self.battery + elapsed)
            self.last = until
            if now < phase["ends"]:
                break
            self.queue.pop(0)
        self.last = now

        if self.queue:
            self.state = self.queue[0]["state"]
            self.task = self.queue[0]["task"]
        elif self.state not in ("idle", "paused"):
            self.state = "idle"
            self.task = "-"

    def status(self):
        with self.lock:
            self._tick()
            return {"battery": round(self.battery), "state": self.state,
                    "task": self.task, "simulated": True, "mode": "simulation"}

    def points(self):
        return MAP_POINTS.copy()

    def start_delivery(self, point):
        with self.lock:
            self._tick()
            if self.queue:
                return {"ok": False, "message": "Eine Aufgabe läuft bereits. Zuerst pausieren."}
            now = self.last
            self.queue = [
                {"state": "delivering", "task": f"Unterwegs zu: {point}", "ends": now + DELIVER_SECS},
                {"state": "returning", "task": "Zurück zur Basis", "ends": now + DELIVER_SECS + RETURN_SECS},
                {"state": "charging", "task": "Lädt an der Basis", "ends": now + DELIVER_SECS + RETURN_SECS + CHARGE_SECS},
            ]
            self._tick()
            return {"ok": True, "message": f"Simulierte Lieferung zu {point} gestartet"}

    def command(self, action):
        with self.lock:
            self._tick()
            now = self.last
            if action == "pause":
                self.queue = []
                self.state = "paused"
                self.task = "Pausiert"
                return {"ok": True, "message": "Simulation pausiert"}
            if action == "return":
                if self.state in ("returning", "charging"):
                    return {"ok": True, "message": "Rückkehr läuft bereits"}
                self.queue = [
                    {"state": "returning", "task": "Zurück zur Basis", "ends": now + RETURN_SECS},
                    {"state": "charging", "task": "Lädt an der Basis", "ends": now + RETURN_SECS + CHARGE_SECS},
                ]
                self._tick()
                return {"ok": True, "message": "Simulierte Rückkehr gestartet"}
            return {"ok": False, "message": "Unbekannter Befehl"}


robot = MockRobot()
app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 8192
app.config["TRUSTED_HOSTS"] = ["127.0.0.1", "localhost"]
FRONTEND = Path(__file__).resolve().parent


@app.before_request
def local_requests_only():
    if request.remote_addr not in ("127.0.0.1", "::1"):
        return jsonify({"ok": False, "message": "Nur auf diesem Laptop verfügbar"}), 403
    if request.method == "POST" and (request.headers.get("Sec-Fetch-Site") == "cross-site" or
        (request.headers.get("Origin") and request.headers["Origin"] != request.host_url.rstrip("/"))):
        return jsonify({"ok": False, "message": "Dashboard direkt auf diesem Laptop öffnen"}), 403


@app.after_request
def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.route("/")
def index():
    return send_from_directory(FRONTEND, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    if filename == "favicon.ico":
        return "", 204
    if filename not in ("index.html", "style.css", "app.js"):
        return jsonify({"ok": False, "message": "Datei nicht gefunden"}), 404
    return send_from_directory(FRONTEND, filename)


@app.route("/robot/status")
def robot_status():
    return jsonify(robot.status())


@app.route("/points")
def points():
    return jsonify({"points": robot.points()})


@app.route("/task/delivery", methods=["POST"])
def task_delivery():
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or "point" not in body or set(body) - {"point", "id", "mapId", "confirmation"}:
        return jsonify({"ok": False, "message": "JSON mit einem Zielpunkt erforderlich"}), 400
    point = body["point"]
    if not isinstance(point, str) or point not in robot.points():
        return jsonify({"ok": False, "message": "Unbekannter Punkt"}), 400
    result = robot.start_delivery(point, body) if hasattr(robot, "_send") else robot.start_delivery(point)
    return jsonify(result), 200 if result["ok"] else 409


@app.route("/command", methods=["POST"])
def command():
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or "action" not in body or set(body) - {"action", "id", "mapId", "confirmation"}:
        return jsonify({"ok": False, "message": "JSON mit einem Befehl erforderlich"}), 400
    action = body["action"]
    if action not in ("pause", "return", "cancel", "reconcile"):
        return jsonify({"ok": False, "message": "Unbekannter Befehl"}), 400
    result = robot.command(action, body) if hasattr(robot, "_send") else robot.command(action)
    return jsonify(result), 200 if result["ok"] else 409


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Local dashboard, simulation by default")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--mode", choices=("simulation", "read-only", "bridge-simulation", "live"), default="simulation")
    args = parser.parse_args()
    if args.mode == "read-only":
        from local_reader import LocalRobotReader
        robot = LocalRobotReader(MAP_POINTS)
    elif args.mode in ("bridge-simulation", "live"):
        from gated_robot import GatedRobot
        robot = GatedRobot(simulated=args.mode == "bridge-simulation",
            lock_path=FRONTEND.parent / ".robot-runtime" / "dashboard-lock.json" if args.mode == "live" else None)
    print(f"Dashboard mode: {args.mode}. Physical trips require a supervised bridge and confirmation for each command.", flush=True)
    app.run(host="127.0.0.1", port=args.port, debug=False)
