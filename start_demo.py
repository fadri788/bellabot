"""Start or check the dashboard and its optional bundled robot connection."""

import argparse
import errno
import hashlib
import json
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener


ROOT = Path(__file__).resolve().parent
PYTHON = ROOT / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
ASSETS = ("index.html", "app.js", "style.css")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def environment(check_only):
    if not PYTHON.is_file():
        if check_only:
            raise RuntimeError("Local Python environment missing. Run start-demo.cmd once.")
        subprocess.run([sys.executable, "-m", "venv", str(ROOT / ".venv")], check=True)
    check = subprocess.run(
        [str(PYTHON), "-c", "from importlib.metadata import version; assert version('Flask') == '3.1.3'"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if check.returncode:
        if check_only:
            raise RuntimeError("Dependencies missing. Run start-demo.cmd once.")
        subprocess.run([str(PYTHON), "-m", "pip", "install", "--disable-pip-version-check",
                        "-r", str(ROOT / "dashboard" / "requirements.txt")], check=True)


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError as error:
            if error.errno not in (errno.EADDRINUSE, 10048):
                raise RuntimeError("Could not check the local preview port.") from error
        else:
            return False
    return True


def existing_preview(port, mode="simulation"):
    if not port_in_use(port):
        return False

    opener = build_opener(ProxyHandler({}), NoRedirect())
    origin = f"http://127.0.0.1:{port}"
    try:
        with opener.open(origin + "/robot/status", timeout=2) as response:
            status = json.loads(response.read(8192))
        if not isinstance(status, dict) or status.get("mode") != mode:
            raise ValueError("Different mode")
        for name in ASSETS:
            with opener.open(origin + "/" + name, timeout=2) as response:
                served = response.read(1024 * 1024)
            expected = (ROOT / "dashboard" / name).read_bytes()
            if hashlib.sha256(served).digest() != hashlib.sha256(expected).digest():
                raise ValueError("Different frontend")
    except (OSError, URLError, ValueError) as error:
        raise RuntimeError(f"Port {port} belongs to a different or unavailable service. Nothing was stopped.") from error
    return True


def start_bridge(mode, check_only):
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Install Node.js 22.9 or newer for the bundled robot connection.")
    version = subprocess.check_output([node, "--version"], text=True).strip().lstrip("v").split(".")
    if tuple(map(int, version[:2])) < (22, 9):
        raise RuntimeError("Node.js 22.9 or newer is required.")
    simulated = mode == "bridge-simulation"
    arguments = [node, str(ROOT / "robot_bridge" / "index.js")]
    if simulated:
        arguments.append("--simulate")
    elif mode == "live":
        arguments.append("--drive")
    if check_only:
        subprocess.run(arguments + ["--check"], cwd=ROOT, check=True)
        return None

    def ready():
        opener = build_opener(ProxyHandler({}), NoRedirect())
        try:
            with opener.open("http://127.0.0.1:3443/state", timeout=1) as response:
                state = json.loads(response.read(1024 * 1024))
        except (OSError, ValueError):
            return False
        if state.get("bridgeProtocol") != "bellabot-dashboard-v1" or state.get("simulated") is not simulated:
            raise RuntimeError("A different service or robot mode uses port 3443. Nothing was stopped.")
        if mode == "live" and (state.get("control") or {}).get("enabled") is not True:
            raise RuntimeError("The existing robot service is read-only. Stop it in its own terminal before starting supervised mode.")
        return True

    if port_in_use(3443):
        if ready():
            print("Using the existing local robot service; this launcher will leave it running.", flush=True)
            return None
        raise RuntimeError("Port 3443 is occupied by a service that is not ready. Nothing was stopped.")
    child = subprocess.Popen(arguments, cwd=ROOT)
    deadline = time.monotonic() + (180 if mode == "live" else 12)
    try:
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError("Robot service could not start. Read its message above.")
            if ready():
                return child
            time.sleep(0.15)
        raise RuntimeError("Robot service did not become ready. No dashboard was started.")
    except BaseException:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=5)
        raise


def main():
    parser = argparse.ArgumentParser(description="Start the dashboard; simulation is the default")
    parser.add_argument("--check", action="store_true", help="Check setup without installing or starting anything")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--mode", choices=("simulation", "bridge-simulation", "read-only", "live"), default="simulation")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("Choose a local port between 1024 and 65535")
    environment(args.check)
    running = existing_preview(args.port, args.mode)
    url = f"http://127.0.0.1:{args.port}/?mode={args.mode}"
    if running:
        print(f"Dashboard is already running in {args.mode}: {url}", flush=True)
        print("Frontend files match. No second server was started.", flush=True)
        return
    bridge = start_bridge(args.mode, args.check) if args.mode != "simulation" else None
    if args.check:
        print(f"Setup ready for {args.mode}. Nothing was started.", flush=True)
        return
    print(f"Open {url}", flush=True)
    print(f"Mode: {args.mode}. Leave this window open; press Ctrl+C to stop.", flush=True)
    try:
        subprocess.run([str(PYTHON), "-B", str(ROOT / "dashboard" / "mock_server.py"),
                        "--mode", args.mode, "--port", str(args.port)], cwd=ROOT, check=True)
    finally:
        if bridge is not None and bridge.poll() is None:
            bridge.terminate()
            bridge.wait(timeout=5)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Demo stopped.")
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
