"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { CAPABILITIES } = require("./capabilities");

// Only sanitized, observed fields leave the listener. Optional control requests
// are handled separately by the gated local-control service.
function publicAtlas(document) {
  const input = document?.map?.elements;
  if (!Array.isArray(input) || input.length > 20000) throw new Error("Unrecognized map.");
  const elements = [];
  for (const item of input) {
    const length = item?.type === "track" ? 4 : item?.type === "source" ? 3 : item?.type === "node" ? 2 : 0;
    if (!length || !Array.isArray(item.vector) || item.vector.length < length ||
        !item.vector.slice(0, length).every(n => Number.isFinite(n) && Math.abs(n) < 1000000)) continue;
    const clean = { type: item.type, vector: item.vector.slice(0, length) };
    if (item.type === "source") {
      if (typeof item.name !== "string" || !item.name.length || item.name.length > 128 || /[\x00-\x1f\x7f]/.test(item.name)) continue;
      clean.name = item.name;
      clean.mode = typeof item.mode === "string" && /^[A-Za-z_]{0,32}$/.test(item.mode) ? item.mode : "unknown";
    }
    elements.push(clean);
  }
  return { id: crypto.createHash("sha256").update(JSON.stringify(elements)).digest("hex"), elements };
}

function createMonitor({ host, robot, expiresAt, now = Date.now }) {
  let connected = false, registered = false, status = null, statusAt = null;
  let destinations = [], rejected = [], total = null, destinationsAt = null, map = null, mapAt = null;
  let mapPending = true;
  const events = [];
  function event(e) {
    const at = new Date(now()).toISOString();
    if (e.event === "mqtt_connected") { connected = true; registered = false; mapPending = true; statusAt = null; }
    if (["connection_closed", "mqtt_disconnected", "listener_stopped"].includes(e.event)) { connected = false; registered = false; }
    if (e.event === "controller_configuration_reported") registered = e.localControllerPresent === true;
    if (e.event === "status_probe_sent" && e.includeMap) mapPending = true;
    if (e.event === "robot_status_response_verified") { status = e.status; statusAt = at; }
    if (e.event === "robot_destinations_response_verified") {
      destinations = e.destinations; rejected = e.rejected || []; total = e.total; destinationsAt = at;
    }
    if (e.event === "current_map_response_verified") mapPending = false;
    if (["mqtt_connected", "connection_closed", "robot_status_response_verified", "robot_destinations_response_verified",
      "current_map_response_verified", "current_map_decode_failed", "listener_stopped"].includes(e.event)) {
      events.unshift({ at, event: e.event });
      events.length = Math.min(events.length, 40);
    }
  }
  return {
    event,
    mapReceived(document) { map = publicAtlas(document); mapAt = new Date(now()).toISOString(); },
    snapshot() {
      const age = now() - Date.parse(statusAt);
      const fresh = connected && registered && statusAt !== null && Number.isFinite(age) && age >= 0 && age < 18000;
      return { source: "local-robot", host, robot, expiresAt, connected, registered, fresh, status, statusAt,
        destinations, rejected, destinationsTotal: total, destinationsAt, map, mapAt, mapPending,
        canControl: false, capabilities: CAPABILITIES, events, observedAt: new Date(now()).toISOString() };
    },
  };
}

function createMonitorServer({ monitor, refresh, control = null, media = null, port = 3443, beforeControl = null }) {
  const server = http.createServer((req, res) => {
    const send = (code, value) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(value)); };
    const expected = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== expected || (req.headers.origin && req.headers.origin !== `http://${expected}`) || req.headers["sec-fetch-site"] === "cross-site") return send(403, { error: "Local access only." });
    if (req.method === "GET" && req.url === "/state") return send(200, { ...monitor.snapshot(), control: control?.snapshot() || null });
    if (req.method === "POST" && req.url === "/control") return send(409, { error: "Use the gated /api/local/control endpoint." });
    if (req.method === "POST" && ["/api/local/control", "/media"].includes(req.url)) {
      if (req.headers["content-type"] !== "application/json") return send(415, { error: "JSON required." });
      const limit = req.url === "/media" ? 28 * 1024 * 1024 : 8192;
      let body = "", bytes = 0;
      req.on("data", chunk => { bytes += chunk.length; if (bytes > limit) req.destroy(); else body += chunk; });
      req.on("end", () => {
        try {
          const service = req.url === "/api/local/control" ? control : media;
          if (!service) return send(409, { error: "This service is not enabled." });
          const input = JSON.parse(body);
          if (req.url === "/api/local/control" && beforeControl) beforeControl(input);
          const result = req.url === "/api/local/control" ? service.execute(input) : service.upload(input);
          send(202, result);
        } catch (e) { send(400, { error: e.message }); }
      });
      return;
    }
    if (req.method === "POST" && req.url === "/refresh") {
      if (req.headers["content-type"] !== "application/json") return send(415, { error: "JSON required." });
      let body = "";
      req.on("data", chunk => { body += chunk; if (body.length > 256) req.destroy(); });
      req.on("end", () => {
        try {
          const input = JSON.parse(body);
          if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "scope") || !["status", "map"].includes(input.scope)) return send(400, { error: "Choose status or map." });
          const accepted = refresh({ map: input.scope === "map" });
          send(accepted ? 202 : 409, { accepted, message: accepted ? "Reading from Bella." : "Bella is disconnected or a read is already in progress. Try again shortly." });
        } catch { send(400, { error: "Invalid request." }); }
      });
      return;
    }
    send(404, { error: "No such read operation." });
  });
  return { server, listen: () => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(server.address()); });
  }), close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

module.exports = { publicAtlas, createMonitor, createMonitorServer };
