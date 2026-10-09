from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mock_server
from local_reader import LocalRobotReader


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.robot = mock_server.MockRobot(clock=lambda: self.now)
        self.previous = mock_server.robot
        mock_server.robot = self.robot
        self.client = mock_server.app.test_client()

    def tearDown(self):
        mock_server.robot = self.previous

    def status(self):
        response = self.client.get("/robot/status")
        self.assertEqual(response.status_code, 200)
        return response.json

    def deliver(self, point="Kitchen"):
        return self.client.post("/task/delivery", json={"point": point})

    def command(self, action):
        return self.client.post("/command", json={"action": action})

    def test_assets_and_points(self):
        for path in ("/", "/index.html", "/style.css", "/app.js"):
            with self.client.get(path) as response:
                self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/points").json["points"], mock_server.MAP_POINTS)
        for path in ("/mock_server.py", "/local_reader.py", "/.env", "/../README.md"):
            self.assertEqual(self.client.get(path).status_code, 404)

    def test_delivery_return_charge_and_completion(self):
        self.assertEqual(self.deliver().status_code, 200)
        self.assertEqual(self.status()["state"], "delivering")
        self.assertEqual(self.status()["task"], "Unterwegs zu: Kitchen")
        self.now += 8
        self.assertEqual(self.status()["state"], "returning")
        self.now += 8
        self.assertEqual(self.status()["state"], "charging")
        self.now += 10
        final = self.status()
        self.assertEqual(final["state"], "idle")
        self.assertEqual(final["task"], "-")
        self.assertEqual(final["battery"], 97)
        self.assertTrue(final["simulated"])

    def test_delayed_polling_accounts_for_each_phase(self):
        self.deliver()
        self.now += 1000
        self.assertEqual(self.status()["battery"], 97)
        self.assertEqual(self.status()["state"], "idle")

    def test_pause_accounts_for_motion_before_stopping(self):
        self.deliver()
        self.now += 5
        self.assertEqual(self.command("pause").status_code, 200)
        self.assertAlmostEqual(self.robot.battery, 90.5)
        self.now += 30
        self.assertEqual(self.status()["state"], "paused")
        self.assertAlmostEqual(self.robot.battery, 90.5)
        self.assertEqual(self.deliver("VR").status_code, 200)
        self.assertEqual(self.status()["task"], "Unterwegs zu: VR")

    def test_return_from_pause_and_duplicate_return(self):
        self.command("pause")
        self.command("return")
        original_end = self.robot.queue[0]["ends"]
        self.now += 4
        self.command("return")
        self.assertEqual(self.robot.queue[0]["ends"], original_end)
        self.now += 4
        self.assertEqual(self.status()["state"], "charging")

    def test_busy_delivery_does_not_replace_current_trip(self):
        self.deliver()
        self.assertEqual(self.deliver("VR").status_code, 409)
        self.assertEqual(self.status()["task"], "Unterwegs zu: Kitchen")

    def test_bad_inputs_do_not_change_robot(self):
        for route, field in (("/task/delivery", "point"), ("/command", "action")):
            for value in (None, [], "", {}, {field: []}, {field: 5}, {field: "unknown"}):
                with self.subTest(route=route, value=value):
                    response = self.client.post(route, json=value)
                    self.assertEqual(response.status_code, 400)
            response = self.client.post(route, data="{", content_type="application/json")
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.status()["state"], "idle")

    def test_idle_time_does_not_drain_battery(self):
        self.now += 10000
        self.assertEqual(self.status()["battery"], 92)
        self.deliver()
        self.assertEqual(self.status()["battery"], 92)


class ReadOnlyTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)
        self.snapshot = {
            "source": "local-robot", "connected": True, "registered": True, "fresh": True,
            "statusAt": self.now.isoformat(), "status": {"robotPower": 61, "moveState": "Idle", "chargeStage": "Idle"},
            "mapPending": False, "map": {"elements": [{"type": "source", "name": "Kitchen"}]},
            "destinations": [{"name": "Kitchen"}],
        }
        self.reader = LocalRobotReader(mock_server.MAP_POINTS, reader=lambda: self.snapshot, clock=lambda: self.now)
        self.previous = mock_server.robot
        mock_server.robot = self.reader
        self.client = mock_server.app.test_client()

    def tearDown(self):
        mock_server.robot = self.previous

    def test_live_status_and_existing_map_points(self):
        status = self.client.get("/robot/status").json
        self.assertEqual(status["battery"], 61)
        self.assertEqual(status["mode"], "read-only")
        self.assertFalse(status["simulated"])
        self.assertEqual(self.client.get("/points").json["points"], ["Kitchen"])

    def test_stale_data_never_falls_back_to_simulation(self):
        self.now += timedelta(seconds=18)
        status = self.reader.status()
        self.assertEqual(status["state"], "offline")
        self.assertEqual(status["battery"], "--")
        self.assertFalse(status["simulated"])
        self.assertEqual(self.reader.points(), [])

    def test_simulator_monitor_is_not_shown_as_live(self):
        self.snapshot["simulated"] = True
        self.assertEqual(self.reader.status()["state"], "offline")
        self.assertEqual(self.reader.points(), [])

    def test_disconnected_and_malformed_monitor(self):
        for value in (None, [], {}, {**self.snapshot, "connected": False},
                      {**self.snapshot, "statusAt": "wrong"},
                      {**self.snapshot, "statusAt": (self.now + timedelta(seconds=1)).isoformat()}):
            with self.subTest(value=value):
                self.snapshot = value
                self.assertEqual(self.reader.status()["state"], "offline")

    def test_unavailable_monitor_has_a_clear_offline_state(self):
        def fail():
            raise OSError("Monitor not running")
        self.reader.reader = fail
        self.assertEqual(self.reader.status()["state"], "offline")

    def test_commands_are_rejected_and_visible_in_existing_task_field(self):
        for route, body in (("/task/delivery", {"point": "Kitchen"}),
                            ("/command", {"action": "pause"}), ("/command", {"action": "return"})):
            response = self.client.post(route, json=body)
            self.assertEqual(response.status_code, 409)
            self.assertFalse(response.json["sentToRobot"])
            self.assertIn("nur Anzeige", self.client.get("/robot/status").json["task"])

    def test_ambiguous_destinations_are_not_shown(self):
        self.snapshot["destinations"].append({"name": "Kitchen"})
        self.assertEqual(self.reader.points(), [])

    def test_live_destination_names_are_preserved_instead_of_filtered_by_demo_spelling(self):
        names = ["kitchen", "3d printer", "table 2", "New stop"]
        self.snapshot["map"]["elements"] = [{"type": "source", "name": name} for name in names]
        self.snapshot["destinations"] = [{"name": name} for name in names]
        self.assertEqual(self.reader.points(), names)

    def test_stationary_busy_robot_is_not_displayed_as_ready(self):
        self.snapshot["status"]["robotState"] = "Busy"
        self.assertEqual(self.reader.status()["state"], "busy")
        self.assertIn("Busy", self.reader.status()["task"])


if __name__ == "__main__":
    unittest.main()
