"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const schema = require("./local-command-schema");

// Durable single-task control. A timeout is UNKNOWN, never an invitation to retry.
// No timers, notifications or reconnects can dispatch a movement command.
function createLocalControl({ snapshot, sendCommand, journalPath, enabled = false, now = Date.now }) {
  let active = null, last = null, busy = false, storageFault = false, connectionLost = false;
  let pendingNotifications = [];
  let receipts = {};
  if (journalPath && fs.existsSync(journalPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      if (saved.version !== 1 || !saved.receipts || typeof saved.receipts !== "object" || Array.isArray(saved.receipts)) throw new Error();
      receipts = saved.receipts; last = saved.last || null;
      if (saved.active) active = { ...saved.active, phase: "unknown", note: "Service restarted. Check and clear the task on Bella before continuing." };
    } catch { storageFault = true; }
  }
  function persist() {
    if (!journalPath) return;
    try {
      const temporary = `${journalPath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, active, last, receipts }), { mode: 0o600 });
      fs.renameSync(temporary, journalPath);
    } catch { storageFault = true; throw new Error("Command history could not be saved. Sending is locked."); }
  }
  const timestamp = () => new Date(now()).toISOString();
  function connected(s) {
    if (!enabled || storageFault) throw new Error("Command service is disabled or its history needs repair.");
    const age = now() - Date.parse(s.statusAt);
    if (!s.connected || !s.registered || !s.fresh || !Number.isFinite(age) || age < 0 || age >= 18000) throw new Error("Wait for a fresh connection to Bella.");
  }
  function idle(s, free = true) {
    if ((free && s.status?.robotState !== "Free") || !(free ? ["Idle"] : ["Idle", "Arrive"]).includes(s.status?.moveState) || s.status?.chargeStage !== "Idle") throw new Error("Bella must report ready, stationary and not charging.");
  }
  function operator(input) {
    const c = input.confirmation;
    if (!c || c.besideRobot !== true || c.correctMapAndPosition !== true || c.clearPathAndStopReady !== true) throw new Error("Confirm you are beside Bella, its map and position are correct, and the path and stop button are ready.");
  }
  function destination(input, s) {
    const age = now() - Date.parse(s.mapAt);
    if (!s.map || s.mapPending || input.mapId !== s.map.id || !Number.isFinite(age) || age < 0 || age > 120000) throw new Error("Refresh Bella's map before sending (map check lasts two minutes).");
    if (s.map.elements.filter(e => e.type === "source" && e.name === input.destination).length !== 1) throw new Error("Choose a unique stop from Bella's current map.");
    const d = schema.buildCall(input.destination, s.destinations).body.destination;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(d.type)) throw new Error("This destination has no validated API type.");
    return d;
  }
  function content(input) {
    const value = input.content;
    if (value?.contentType === "img" && (value.showTimeout !== -1 || value.cancelBtnTime !== 0)) throw new Error("Pictures must stay open without a timeout and show the cancel button.");
    if (value?.contentType === "video" && input.confirmation?.returnPathChecked !== true) throw new Error("Video completion can start the return trip. Confirm Bella's return point and path first.");
    for (const url of value?.urls || []) {
      let parsed; try { parsed = new URL(url); } catch { throw new Error("Use a robot-reachable media URL."); }
      if (parsed.hostname === "localhost" || parsed.hostname === "[::1]" || /^127\./.test(parsed.hostname)) throw new Error("Bella cannot read laptop loopback URLs. Upload the file here instead.");
    }
    return value;
  }
  function view() {
    let reason = null;
    try { const s = snapshot(); connected(s); if (!active) idle(s); } catch (e) { reason = e.message; }
    return { enabled, busy, storageFault, active, last, ready: !reason && !active && !busy, reason,
      note: "New controls await a supervised live test. An accepted reply does not prove arrival." };
  }
  function execute(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["id", "action", "destination", "mapId", "content", "confirmation"].includes(k))) throw new Error("Invalid control request.");
    if (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id)) throw new Error("A unique request id is required.");
    const digest = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
    if (Object.hasOwn(receipts, input.id)) {
      if (receipts[input.id].digest !== digest) throw new Error("This request id was already used for a different action.");
      return { ...receipts[input.id], duplicate: true };
    }
    if (Object.keys(receipts).length >= 2000) throw new Error("Command history is full. Archive it while Bella is disconnected and has no task.");
    if (busy) throw new Error("Wait for the current command reply. Do not resend.");
    const s = snapshot(); connected(s); operator(input);
    let request;
    const previousActive = active;
    if (input.action === "reconcile") {
      idle(s);
      if (!active || input.confirmation.robotTaskCleared !== true || Date.parse(s.statusAt) <= Date.parse(active.issuedAt)) throw new Error("Check Bella has no active or queued task, then wait for a newer ready/stationary reading.");
      last = { ...active, phase: "operator-cleared", at: timestamp() }; active = null;
      const receipt = { id: input.id, digest, outcome: "local-only", message: "Task cleared on this laptop. No robot command was sent." };
      receipts[input.id] = receipt; persist(); return receipt;
    }
    if (["go", "screen"].includes(input.action)) {
      if (active) throw new Error("Finish and verify the current task before starting another.");
      idle(s); const dest = destination(input, s);
      request = input.action === "go" ? schema.buildCall(dest.name, s.destinations) : schema.buildCustomCall(dest.name, s.destinations, content(input));
      active = { kind: request.msgType, destination: dest, mapId: s.map.id, issuedAt: timestamp(), phase: "sending", taskId: null };
    } else {
      if (!active || input.mapId !== active.mapId || s.map?.id !== active.mapId || s.mapPending) throw new Error("There is no matching active task on the current map.");
      if (input.action === "cancel" && active.kind === "call") request = schema.buildCancelCall(active.destination.name, [active.destination]);
      else if (input.action === "cancel" && active.taskId) {
        if (input.confirmation.returnPathChecked !== true) throw new Error("Cancelling this screen task can start a return trip. Check the return point and path.");
        request = schema.buildCustomCallCancel(active.taskId);
      } else if (["update", "finish", "next"].includes(input.action) && active.taskId && active.phase === "Arrived") {
        idle(s, false);
        if (input.action === "update") request = schema.buildCustomCallContent(active.taskId, content(input));
        else if (input.action === "next") {
          const dest = destination(input, s);
          request = schema.buildCustomCallComplete(active.taskId, { name: dest.name, destinations: s.destinations, content: content(input) });
        } else {
          if (input.confirmation.returnPathChecked !== true) throw new Error("Finishing can start a return trip. Check the return point and path.");
          request = schema.buildCustomCallComplete(active.taskId);
        }
      } else throw new Error("That operation is not available for this task. Screen updates need a verified Arrived notification.");
    }
    if (Buffer.byteLength(JSON.stringify(request)) > 7000) { active = previousActive; throw new Error("Content request is too large. Use fewer or shorter URLs."); }
    const before = { ...active };
    active.lastAction = input.action; active.issuedAt = timestamp();
    // Preserve Arrived across an update, but prevent more commands while busy.
    busy = true;
    connectionLost = false;
    pendingNotifications = [];
    const receipt = { id: input.id, digest, outcome: "pending", action: input.action, at: timestamp() };
    receipts[input.id] = receipt;
    try { persist(); } catch (e) { busy = false; throw e; }
    let result;
    try { result = sendCommand(request); } catch { result = { outcome: "unknown", reason: "Transport was unavailable. Check Bella before continuing." }; }
    Promise.resolve(result).then(reply => {
      busy = false;
      receipts[input.id] = { ...receipt, ...reply, at: timestamp() };
      last = receipts[input.id];
      if (reply.outcome === "unknown") { active.phase = "unknown"; active.note = reply.reason; }
      else if (reply.outcome === "rejected") {
        // A rejected customCall can retain a task id in older firmware. Keep locked.
        if (input.action === "go") active = null;
        else { active.phase = "check-robot"; active.note = reply.reason || "Bella rejected the command. Check its screen and clear any held task."; }
      } else if (["go", "screen"].includes(input.action)) {
        active.phase = "accepted"; active.taskId = reply.taskId || null;
        active.note = "Accepted by Bella. Waiting for an arrival event; it may be queued.";
      } else if (input.action === "update") active.phase = before.phase;
      else if (input.action === "next" && reply.nextTaskAccepted && reply.nextTaskId) {
        active = { kind: "customCall", destination: request.body.nextCallTask.destination, mapId: s.map.id, issuedAt: timestamp(), phase: "accepted", taskId: reply.nextTaskId };
      } else { active.phase = "check-robot"; active.note = "Check Bella before clearing this task. A cancel reply is not proof of stopping; finishing a screen task can trigger return."; }
      // A late reply records what was acknowledged but cannot restore certainty
      // after the connection dropped, even when buffered events report arrival.
      if (connectionLost) {
        active ??= before;
        active.phase = "unknown";
        active.note = "Connection lost. Check the task on Bella before continuing.";
      }
      try { persist(); } catch { /* storageFault keeps all further control locked */ }
      // A task event can arrive before its acknowledgement. Process it only
      // after the reply supplies the matching task id, without sending anything.
      for (const notification of pendingNotifications.splice(0)) event(notification);
    }).catch(() => { busy = false; active.phase = "unknown"; active.note = "Command outcome could not be established."; try { persist(); } catch {} });
    return { ...receipt, message: "Sent once. Watch Bella and its reply below." };
  }
  function event(e) {
    if (!active) return;
    if (e.event === "robot_task_notification" && busy) { if (pendingNotifications.length < 16) pendingNotifications.push(e); return; }
    if (["connection_closed", "mqtt_disconnected", "listener_stopped"].includes(e.event)) {
      connectionLost = true;
      active.phase = "unknown"; active.note = "Connection lost. Check the task on Bella before continuing.";
    } else if (e.event === "robot_task_notification" && !busy && !["unknown", "check-robot"].includes(active.phase) && e.kind === active.kind &&
        e.notification.destinationName === active.destination.name &&
        (active.kind === "customCall" ? e.notification.taskId === active.taskId : e.notification.destinationType === active.destination.type)) {
      active.phase = e.notification.state; active.notificationAt = timestamp(); active.note = "Reported by Bella. Confirm the physical position before continuing.";
    } else return;
    try { persist(); } catch {}
  }
  return { snapshot: view, execute, event };
}

module.exports = { createLocalControl };
