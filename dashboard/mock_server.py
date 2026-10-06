from flask import Flask, jsonify, request, send_from_directory
import time

# --- Die Punkte deiner Karte (spaeter gegen echte Namen tauschen) ---
MAP_POINTS = [
    "3D Printer", "Avatar", "VR", "Accenture Robot", "Kitchen",
    "Meeting", "Printer", "Table2", "Tables", "Trash", "TV", "WC"]


# --- Der Fake-Roboter -----------------------------------------------
class MockRobot:
    def __init__(self):
        self.battery = 92        # Akku in Prozent
        self.state = "idle"      # idle | delivering | returning | charging | paused
        self.task = "-"          # was er gerade tut

    def status(self):
        return {
            "battery": self.battery,
            "state": self.state,
            "task": self.task,
        }

    def send_to(self, point):
        self.state = "delivering"
        self.task = f"Unterwegs zu: {point}"
        return {"ok": True, "message": f"Faehrt zu {point}"}

    def return_to_base(self):
        self.state = "returning"
        self.task = "Zurueck zur Basis"
        return {"ok": True, "message": "Kehrt zur Basis zurueck"}

    def pause(self):
        self.state = "paused"
        self.task = "Pausiert"
        return {"ok": True, "message": "Pausiert"}


robot = MockRobot()


# --- Die App: Webseite + API ----------------------------------------
app = Flask(__name__)

@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(".", filename)

@app.route("/api/status")
def api_status():
    data = robot.status()
    data["points"] = MAP_POINTS
    return jsonify(data)

@app.route("/api/send", methods=["POST"])
def api_send():
    point = request.json.get("point", "")
    return jsonify(robot.send_to(point))

@app.route("/api/return", methods=["POST"])
def api_return():
    return jsonify(robot.return_to_base())

@app.route("/api/pause", methods=["POST"])
def api_pause():
    return jsonify(robot.pause())


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)