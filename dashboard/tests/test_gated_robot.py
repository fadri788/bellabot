from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gated_robot import GatedRobot
import mock_server


class GatedRobotTests(unittest.TestCase):
    def setUp(self):
        self.now = 1800000000.0
        stamp = datetime.fromtimestamp(self.now, timezone.utc).isoformat()
        self.snapshot = {"source": "local-robot", "bridgeProtocol": "bellabot-dashboard-v1", "identityVerified": True, "simulated": False,
            "connected": True, "registered": True, "fresh": True, "statusAt": stamp, "mapAt": stamp, "mapPending": False,
            "status": {"robotPower": 80, "robotState": "Free", "moveState": "Idle", "chargeStage": "Idle"},
            "control": {"enabled": True, "ready": True, "busy": False, "active": None},
            "map": {"id": "map-a", "elements": [{"type": "source", "name": "Kitchen"}]},
            "destinations": [{"name": "Kitchen", "type": "table"}], "returnDestination": "Kitchen"}
        self.posts = []
        self.reply = (202, {"outcome": "pending"})
        self.robot = GatedRobot(transport=self.transport, clock=lambda: self.now)

    def transport(self, route, body=None):
        if route == "/state":
            return 200, deepcopy(self.snapshot)
        self.assertEqual(route, "/api/local/control")
        self.posts.append(deepcopy(body))
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply

    def body(self, cleared=False):
        return {"id": str(uuid4()), "mapId": "map-a", "confirmation": {"besideRobot": True,
            "correctMapAndPosition": True, "clearPathAndStopReady": True, **({"robotTaskCleared": True} if cleared else {})}}

    def advance(self):
        self.now += 2
        self.snapshot["statusAt"] = datetime.fromtimestamp(self.now, timezone.utc).isoformat()

    def test_confirmed_destination_uses_only_the_control_gate(self):
        self.assertTrue(self.robot.status()["canGo"])
        result = self.robot.start_delivery("Kitchen", self.body())
        self.assertTrue(result["ok"])
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.posts[0]["action"], "go")
        self.assertEqual(self.posts[0]["destination"], "Kitchen")

    def test_missing_confirmation_never_sends(self):
        for key in ("besideRobot", "correctMapAndPosition", "clearPathAndStopReady"):
            body = self.body()
            body["confirmation"][key] = False
            self.assertFalse(self.robot.start_delivery("Kitchen", body)["ok"])
        self.assertFalse(self.robot.start_delivery("Kitchen", {})["ok"])
        self.assertEqual(self.posts, [])

    def test_destination_spelling_in_commands_matches_the_live_map_exactly(self):
        self.snapshot["map"]["elements"][0]["name"] = "kitchen"
        self.snapshot["destinations"][0]["name"] = "kitchen"
        self.assertFalse(self.robot.start_delivery("Kitchen", self.body())["ok"])
        self.assertTrue(self.robot.start_delivery("kitchen", self.body())["ok"])
        self.assertEqual([post["destination"] for post in self.posts], ["kitchen"])

    def test_stationary_busy_robot_stays_locked(self):
        self.snapshot["status"]["robotState"] = "Busy"
        self.snapshot["control"]["ready"] = False
        status = self.robot.status()
        self.assertEqual(status["state"], "busy")
        self.assertFalse(status["canGo"])
        self.assertFalse(status["canReturn"])

    def test_changed_map_and_unknown_destination_never_send(self):
        body = self.body()
        body["mapId"] = "old-map"
        self.assertFalse(self.robot.start_delivery("Kitchen", body)["ok"])
        self.assertFalse(self.robot.start_delivery("Unknown", self.body())["ok"])
        self.assertEqual(self.posts, [])

    def test_stale_and_wrong_mode_never_send(self):
        self.snapshot["fresh"] = False
        self.assertEqual(self.robot.status()["state"], "offline")
        self.assertFalse(self.robot.start_delivery("Kitchen", self.body())["ok"])
        self.snapshot["fresh"] = True
        self.snapshot["simulated"] = True
        self.assertEqual(self.robot.status()["state"], "offline")
        self.assertFalse(self.robot.start_delivery("Kitchen", self.body())["ok"])
        self.assertEqual(self.posts, [])

    def test_timeout_blocks_new_commands_until_a_physical_check(self):
        self.reply = TimeoutError()
        self.assertEqual(self.robot.start_delivery("Kitchen", self.body())["outcome"], "unknown")
        self.assertFalse(self.robot.start_delivery("Kitchen", self.body())["ok"])
        self.assertEqual(len(self.posts), 1)
        self.assertFalse(self.robot.status()["canGo"])
        self.advance()
        self.assertTrue(self.robot.status()["canReconcile"])
        self.assertFalse(self.robot.command("reconcile", self.body())["ok"])
        self.assertTrue(self.robot.command("reconcile", self.body(cleared=True))["ok"])
        self.assertEqual(len(self.posts), 1)
        self.assertTrue(self.robot.status()["canGo"])

    def test_command_record_survives_restart_and_successful_clear(self):
        with tempfile.TemporaryDirectory() as folder:
            lock = Path(folder) / "lock.json"
            robot = GatedRobot(transport=self.transport, lock_path=lock, clock=lambda: self.now)
            self.reply = TimeoutError()
            robot.start_delivery("Kitchen", self.body())
            restarted = GatedRobot(transport=self.transport, lock_path=lock, clock=lambda: self.now)
            self.assertFalse(restarted.status()["canGo"])
            self.advance()
            restarted.command("reconcile", self.body(cleared=True))
            restored = GatedRobot(transport=self.transport, lock_path=lock, clock=lambda: self.now)
            self.assertTrue(restored.status()["canGo"])

    def test_storage_failure_prevents_sending(self):
        with tempfile.TemporaryDirectory() as folder:
            robot = GatedRobot(transport=self.transport, lock_path=Path(folder) / "lock.json", clock=lambda: self.now)
            with patch("gated_robot.os.replace", side_effect=OSError()):
                self.assertFalse(robot.start_delivery("Kitchen", self.body())["ok"])
            self.assertEqual(self.posts, [])
            self.assertFalse(robot.status()["canGo"])

    def test_storage_failure_after_dispatch_keeps_the_outcome_unknown(self):
        with tempfile.TemporaryDirectory() as folder:
            robot = GatedRobot(transport=self.transport, lock_path=Path(folder) / "lock.json", clock=lambda: self.now)
            with patch("gated_robot.os.replace", side_effect=[None, OSError()]):
                result = robot.start_delivery("Kitchen", self.body())
            self.assertEqual(result["outcome"], "unknown")
            self.assertEqual(len(self.posts), 1)
            self.assertFalse(robot.status()["canGo"])
            self.assertFalse(robot.status()["canReconcile"])

    def test_malformed_bridge_data_is_offline_and_cannot_send(self):
        original = deepcopy(self.snapshot)
        for field, value in (("bridgeProtocol", "other"), ("map", []), ("destinations", None),
                             ("control", {"active": "bad"})):
            self.snapshot = {**original, field: value}
            self.assertEqual(self.robot.status()["state"], "offline")
            self.assertEqual(self.robot.points(), [])
            self.assertFalse(self.robot.start_delivery("Kitchen", self.body())["ok"])
        self.assertEqual(self.posts, [])

    def test_return_uses_an_explicit_named_point_without_auto_charging(self):
        self.assertTrue(self.robot.command("return", self.body())["ok"])
        self.assertEqual(self.posts[0]["destination"], "Kitchen")
        self.snapshot["returnDestination"] = None
        self.assertFalse(self.robot.command("return", self.body())["ok"])
        self.assertEqual(len(self.posts), 1)

    def test_pause_is_not_silently_converted_to_cancellation(self):
        self.assertFalse(self.robot.command("pause", self.body())["ok"])
        self.assertEqual(self.posts, [])
        self.assertTrue(self.robot.command("cancel", self.body())["ok"])
        self.assertEqual(self.posts[0]["action"], "cancel")

    def test_cross_site_browser_requests_cannot_reach_the_adapter(self):
        previous = mock_server.robot
        mock_server.robot = self.robot
        try:
            client = mock_server.app.test_client()
            response = client.post("/task/delivery", json={"point": "Kitchen", **self.body()}, headers={"Origin": "https://example.invalid"})
            self.assertEqual(response.status_code, 403)
            self.assertEqual(self.posts, [])
        finally:
            mock_server.robot = previous


if __name__ == "__main__":
    unittest.main()
