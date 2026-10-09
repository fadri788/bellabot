"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const readline = require("node:readline/promises");
const { execFileSync } = require("node:child_process");
const { createObserver } = require("./src/local-mqtt-observer");
const { createMonitor, createMonitorServer } = require("./src/local-monitor");
const { createLocalControl } = require("./src/local-control");
const { localIPv4, normaliseMac, matchingNeighbour } = require("./src/network");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME = path.join(ROOT, ".robot-runtime");

function loadConfig() {
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(ROOT, ".robot-local.json"), "utf8").replace(/^\uFEFF/, "")); }
  catch { throw new Error("Create .robot-local.json from robot-config.example.json with this laptop and robot's current details."); }
  if (![config.laptopIp, config.robotIp].every(value => localIPv4(value) && !value.startsWith("127.")) ||
      config.laptopIp === config.robotIp || !normaliseMac(config.robotMac) ||
      (config.returnDestination && (typeof config.returnDestination !== "string" || config.returnDestination.length > 128 || /[\x00-\x1f\x7f]/.test(config.returnDestination)))) {
    throw new Error("The local robot configuration needs valid private addresses and the confirmed robot MAC.");
  }
  return config;
}

function verifyIdentity(config) {
  const local = Object.entries(os.networkInterfaces()).find(([, entries]) => entries.some(entry => entry.address === config.laptopIp));
  if (!local) throw new Error("Configured laptop address is not on a current network interface.");
  let neighbours;
  try { neighbours = execFileSync("arp", [process.platform === "win32" ? "-a" : "-an"], { encoding: "utf8", windowsHide: true, timeout: 5000 }); }
  catch { throw new Error("Could not verify the robot in the local neighbour table."); }
  if (!matchingNeighbour(neighbours, config, local[0])) throw new Error("Robot MAC does not match this address on this network. Check Bella's current Wi-Fi address; no connection was started.");
}

async function main(argv = process.argv.slice(2)) {
  if (argv.some(arg => !["--simulate", "--drive", "--check"].includes(arg)) || (argv.includes("--simulate") && argv.includes("--drive"))) {
    throw new Error("Use node robot_bridge/index.js [--simulate | --drive] [--check]");
  }
  const simulated = argv.includes("--simulate");
  const drive = simulated || argv.includes("--drive");
  const config = simulated ? { laptopIp: "127.0.0.1", robotIp: "127.0.0.1", returnDestination: "Base" } : loadConfig();
  let certificate;
  if (!simulated) {
    verifyIdentity(config);
    try { certificate = JSON.parse(fs.readFileSync(path.join(RUNTIME, "listener-certificate.json"), "utf8").replace(/^\uFEFF/, "")); }
    catch { throw new Error("Prepare a fresh listener certificate on this laptop. See robot_bridge/README.md."); }
    if (certificate.host !== config.laptopIp || !Number.isFinite(Date.parse(certificate.expiresAt)) || Date.parse(certificate.expiresAt) <= Date.now() || !certificate.pfx || !certificate.passphrase) {
      throw new Error("The local listener certificate is missing, expired or belongs to another laptop address.");
    }
  }
  if (argv.includes("--check")) { console.log(`${simulated ? "Simulation" : "Robot"} bridge setup is ready. Nothing started.`); return; }
  if (!simulated && drive) {
    if (!process.stdin.isTTY) throw new Error("Start --drive in a terminal with the operator beside Bella.");
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await terminal.question("With someone beside Bella and the stop button ready, type DRIVE to enable supervised trips: "); }
    finally { terminal.close(); }
    if (answer !== "DRIVE") throw new Error("Driving was not enabled.");
  }
  fs.mkdirSync(RUNTIME, { recursive: true });
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const baseMonitor = createMonitor({ host: config.laptopIp, robot: config.robotIp, expiresAt });
  const monitor = { ...baseMonitor, snapshot: () => ({ ...baseMonitor.snapshot(), bridgeProtocol: "bellabot-dashboard-v1", simulated,
    identityVerified: !simulated, returnDestination: config.returnDestination || null }) };
  let control;
  let observer;
  let arrivalTimer;
  let simulatedStatus = { robotPower: 92, robotState: "Free", moveState: "Idle", chargeStage: "Idle" };
  function event(value) { baseMonitor.event(value); control?.event(value); }
  function fixtureReads() {
    event({ event: "robot_status_response_verified", status: { ...simulatedStatus } });
    event({ event: "robot_destinations_response_verified", destinations: ["Kitchen", "VR", "Base"].map(name => ({ name, type: "table" })) });
    baseMonitor.mapReceived({ map: { elements: ["Kitchen", "VR", "Base"].map((name, index) => ({ type: "source", name, vector: [index * 2, index, 0] })) } });
    event({ event: "current_map_response_verified" });
    return true;
  }
  function simulatedCommand(request) {
    clearTimeout(arrivalTimer);
    const destination = request.body.destination;
    if (request.msgType === "call") {
      simulatedStatus = { ...simulatedStatus, robotState: "Busy", moveState: "Moving" };
      fixtureReads();
      arrivalTimer = setTimeout(() => {
        simulatedStatus = { ...simulatedStatus, robotState: "Free", moveState: "Idle" };
        fixtureReads();
        event({ event: "robot_task_notification", kind: "call", notification: { state: "Arrived", destinationName: destination.name, destinationType: destination.type } });
      }, 3500);
    } else if (request.msgType === "cancelCall") {
      simulatedStatus = { ...simulatedStatus, robotState: "Free", moveState: "Idle" };
      fixtureReads();
    } else throw new Error("Simulation supports only named trips and cancellation.");
    return Promise.resolve({ outcome: "accepted", accepted: true });
  }
  control = createLocalControl({ snapshot: monitor.snapshot, enabled: drive,
    journalPath: simulated ? null : path.join(RUNTIME, "command-journal.json"),
    sendCommand: request => simulated ? simulatedCommand(request) : observer.sendCommand(request) });
  if (simulated) {
    event({ event: "mqtt_connected" });
    event({ event: "controller_configuration_reported", localControllerPresent: true });
    fixtureReads();
  } else {
    observer = createObserver({ host: config.laptopIp, robot: config.robotIp,
      pfx: Buffer.from(certificate.pfx, "base64"), passphrase: certificate.passphrase,
      controllerId: `pudu-laptop-${crypto.randomBytes(8).toString("hex")}`, statusProbe: true, mapRead: true, commandSupport: drive,
      event, mapReceived: document => baseMonitor.mapReceived(document) });
  }
  const bridge = createMonitorServer({ monitor, control,
    refresh: options => simulated ? fixtureReads() : observer.refreshReads(options),
    beforeControl: input => {
      if (!["go", "cancel", "reconcile"].includes(input?.action)) throw new Error("Only named trips, cancellation and operator reconciliation are enabled.");
      if (!simulated) verifyIdentity(config);
    } });
  let stopped = false;
  let polling;
  let deadline;
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(polling); clearTimeout(deadline); clearTimeout(arrivalTimer);
    await bridge.close();
    if (observer) await observer.close();
  }
  try {
    await bridge.listen();
    if (observer) await observer.listen();
  } catch (error) { await stop(); throw error; }
  polling = setInterval(() => {
    if (simulated) fixtureReads();
    else observer.refreshReads({ map: Date.now() - Date.parse(baseMonitor.snapshot().mapAt || "") > 60000 || !baseMonitor.snapshot().mapAt });
  }, simulated ? 2000 : 6000);
  deadline = setTimeout(stop, 2 * 60 * 60 * 1000);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  bridge.server.on("error", () => { process.exitCode = 1; void stop(); });
  observer?.server.on("error", () => { process.exitCode = 1; void stop(); });
  console.log(`${simulated ? "SIMULATION" : drive ? "SUPERVISED ROBOT" : "READ-ONLY ROBOT"} bridge ready on 127.0.0.1:3443. Session expires after two hours.`);
  if (!simulated) console.log("With the operator's permission, Bella's Robot API / Local / Host must point to this laptop's configured address on port 8443.");
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, loadConfig, verifyIdentity };
