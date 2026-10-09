"use strict";

const tls = require("node:tls");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { TextDecoder } = require("node:util");
const { localIPv4 } = require("./network");
const { MSG_TYPES, interpretReply, parseCustomCallNotification } = require("./local-command-schema");

// Small dedicated MQTT 3.1.1 peer for one robot, not a general broker.
// Default mode emits no application messages. Explicit modes add registration,
// fixed reads, and optionally the source-backed command allowlist. Public control
// requests pass through local-control's state/map/supervision gates first.
const MAX_PACKET = 256 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const SAFE_KEYS = new Set([
  "msgType", "msgId", "source", "target", "body", "version", "state", "reported",
  "desired", "params", "method", "timestamp", "data", "type", "code", "message",
  "status", "id", "groupId",
]);

function topicShape(topic) {
  const parts = topic.split("/");
  if (parts.length === 5 && parts[0] === "" && parts[3] === "user" &&
      /^(pub|sub)(_sdk|_service|_group|_disinfection)?$/.test(parts[4])) {
    return `/{product}/{device}/user/${parts[4]}`;
  }
  if (parts.length === 5 && parts[0] === "" && parts[1] === "shadow" &&
      ["get", "update"].includes(parts[2])) return `/shadow/${parts[2]}/{product}/{device}`;
  if (parts.length === 5 && parts[0] === "" && parts[3] === "connect" && parts[4] === "status") {
    return "/{product}/{device}/connect/status";
  }
  if (parts.length === 8 && parts[0] === "" && parts[1] === "sys" &&
      parts.slice(4).join("/") === "thing/event/property/post") {
    return "/sys/{product}/{device}/thing/event/property/post";
  }
  return "[unrecognized topic omitted]";
}

function payloadShape(payload) {
  const result = { bytes: payload.length, jsonObject: false };
  try {
    const data = JSON.parse(decoder.decode(payload));
    if (data && typeof data === "object" && !Array.isArray(data)) {
      result.jsonObject = true;
      result.knownKeys = Object.keys(data).filter((key) => SAFE_KEYS.has(key));
      result.otherKeyCount = Object.keys(data).length - result.knownKeys.length;
      // These protocol discriminator values are not credentials or identifiers.
      if (typeof data.msgType === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(data.msgType)) result.messageType = data.msgType;
      if (["get", "update", "reply"].includes(data.method)) result.method = data.method;
    }
  } catch { /* Do not log raw payloads, parsing errors or unknown field names. */ }
  return result;
}

function cursor(body) {
  let offset = 0;
  function take(length) {
    if (offset + length > body.length) throw new Error("Truncated MQTT packet.");
    const part = body.subarray(offset, offset + length);
    offset += length;
    return part;
  }
  return {
    byte: () => take(1)[0],
    uint16: () => take(2).readUInt16BE(),
    binary() { return take(this.uint16()); },
    string() {
      let text;
      try { text = decoder.decode(this.binary()); }
      catch { throw new Error("Invalid MQTT string."); }
      if (text.includes("\0")) throw new Error("Invalid MQTT string.");
      return text;
    },
    rest: () => take(body.length - offset),
    done: () => offset === body.length,
  };
}

function createMqttSession({ write, event = () => {}, end = () => {}, keepAlive = () => {}, controllerId = null, statusProbe = false, mapRead = false, mapReceived = () => {}, commandSupport = false, commandTimeoutMs = 12000, now = Date.now }) {
  if (controllerId !== null && !/^pudu-laptop-[a-f0-9]{16}$/.test(controllerId)) throw new Error("Invalid local controller identifier.");
  if (statusProbe && !controllerId) throw new Error("Status probe requires local registration.");
  let buffered = Buffer.alloc(0);
  let connected = false;
  let ended = false;
  const pendingQos2 = new Set();
  const subscriptions = new Set();
  let registrationSent = false;
  let registered = false;
  let registeredNamespace = null;
  let statusRequestId = null;
  let destinationsRequestId = null;
  let mapRequestId = null;
  let onlineReplies = 0;
  let readBusyUntil = 0;
  let lastReadAt = -Infinity;
  let includeMap = mapRead;
  let initialMapComplete = false;
  let pendingCommand = null;
  function settleCommand(result) {
    if (!pendingCommand) return;
    const pending = pendingCommand; pendingCommand = null;
    clearTimeout(pending.timer); pending.resolve(result);
  }
  function close() {
    ended = true;
    settleCommand({ outcome: "unknown", reason: "Connection lost. Check Bella before doing anything else." });
  }
  function sendCommand(command) {
    if (!commandSupport || !connected || ended || !registered || !subscriptions.has(`/${registeredNamespace}/user/sub_sdk`)) throw new Error("Command connection is not ready.");
    if (pendingCommand) throw new Error("A command reply is already pending.");
    if (!Object.values(MSG_TYPES).includes(command?.msgType) || !command.body || Buffer.byteLength(JSON.stringify(command)) > 7000) throw new Error("Unsupported command.");
    const msgId = crypto.randomBytes(16).toString("hex");
    return new Promise(resolve => {
      pendingCommand = { msgId, msgType: command.msgType, resolve,
        timer: setTimeout(() => settleCommand({ outcome: "unknown", reason: "No matching reply. The command may have run. No retry was sent." }), commandTimeoutMs) };
      try {
        sendSetupMessage(`/${registeredNamespace}/user/sub_sdk`, { ...command, msgId, source: controllerId, target: registeredNamespace.split("/")[1] });
        event({ event: "robot_command_sent", messageType: command.msgType });
      } catch { settleCommand({ outcome: "unknown", reason: "Transport failed. Check Bella; no retry was sent." }); }
    });
  }
  function refreshReads({ map = false } = {}) {
    if (!connected || ended || !registered || !statusProbe || (map && !mapRead) ||
        !subscriptions.has(`/${registeredNamespace}/user/sub_sdk`) || now() < readBusyUntil || now() - lastReadAt < 2000) return false;
    // A periodic poll can beat the robot's first presence message after reconnect.
    // Always finish the initial map cycle before allowing status-only polling.
    includeMap = mapRead && (map || !initialMapComplete);
    lastReadAt = now();
    readBusyUntil = now() + 12000;
    statusRequestId = crypto.randomBytes(8).toString("hex");
    destinationsRequestId = null;
    mapRequestId = null;
    sendSetupMessage(`/${registeredNamespace}/user/sub_sdk`, {
      msgType: "query_state", msgId: statusRequestId, source: controllerId, target: registeredNamespace.split("/")[1],
    });
    event({ event: "status_probe_sent", messageType: "query_state", includeMap, motionCommandsEnabled: commandSupport });
    return true;
  }
  function sendSetupMessage(topic, data) {
    const topicBytes = Buffer.from(topic);
    const body = Buffer.concat([Buffer.from([topicBytes.length >> 8, topicBytes.length & 255]), topicBytes, Buffer.from(JSON.stringify(data))]);
    if (body.length > 8192) throw new Error("Local setup response exceeds limit.");
    let length = body.length;
    const encoded = [];
    do { const digit = length % 128; length = Math.floor(length / 128); encoded.push(digit | (length ? 128 : 0)); } while (length);
    write(Buffer.concat([Buffer.from([0x30, ...encoded]), body]));
  }
  function localSetup(topic, payload) {
    if (!controllerId) return;
    let data;
    try { data = JSON.parse(decoder.decode(payload)); } catch { return; }
    if (commandSupport && registered && topic === `/${registeredNamespace}/user/pub_sdk` &&
        data?.target === controllerId && data.source === registeredNamespace.split("/")[1]) {
      if (pendingCommand && data.msgId === pendingCommand.msgId && data.msgType === pendingCommand.msgType) {
        const reply = interpretReply(data.msgType, data.body);
        if (reply.recognized) {
          event({ event: "robot_command_reply_verified", messageType: data.msgType, accepted: reply.accepted });
          settleCommand({ outcome: reply.accepted ? "accepted" : "rejected", ...reply });
        }
        return;
      }
      if (data.msgType === "notifyCustomCall") {
        const notification = parseCustomCallNotification(data.body);
        if (notification.recognized) event({ event: "robot_task_notification", kind: "customCall", notification });
        return;
      }
      if (data.msgType === "notifyGoState") {
        const b = data.body;
        if (["Arriving", "Arrived", "Cancel"].includes(b?.robotGoState) && typeof b.destination?.name === "string" &&
            b.destination.name.length > 0 && b.destination.name.length <= 128 && !/[\x00-\x1f\x7f]/.test(b.destination.name) &&
            typeof b.destination.type === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(b.destination.type)) {
          event({ event: "robot_task_notification", kind: "call", notification: {
            state: b.robotGoState, destinationName: b.destination.name, destinationType: b.destination.type,
          } });
        }
        return;
      }
    }
    if (registered && topic === `/${registeredNamespace}/user/pub_service` && data?.msgType === "getDeviceOnlineState" &&
        data.target === controllerId && data.source === registeredNamespace.split("/")[1] &&
        typeof data.msgId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(data.msgId) && onlineReplies < 8 &&
        subscriptions.has(`/${registeredNamespace}/user/sub_service`)) {
      // Message type was observed from the live robot; schema from
      // DeviceOnlineBody and PubServiceGetDeviceOnlineState, not cloud credentials.
      sendSetupMessage(`/${registeredNamespace}/user/sub_service`, {
        msgType: data.msgType, msgId: data.msgId, source: controllerId, target: data.source,
        body: { state: "ONLINE", sourceType: "sdk", source: controllerId },
      });
      onlineReplies++;
      event({ event: "local_controller_online_replied" });
      if (statusProbe && !statusRequestId && subscriptions.has(`/${registeredNamespace}/user/sub_sdk`)) {
        // Exact literal/schema recovered as source text from the older local
        // server's app/pddevice/{const,protocols}.js. Verify the live response.
        refreshReads({ map: mapRead });
      }
      return;
    }
    if (statusRequestId && topic === `/${registeredNamespace}/user/pub_sdk` &&
        data?.msgType === "query_state" && data.msgId === statusRequestId && data.target === controllerId &&
        data.source === registeredNamespace.split("/")[1]) {
      const b = data.body;
      if (!b || !["Free", "Busy"].includes(b.robotState) || !Number.isInteger(b.robotPower) || b.robotPower < 0 || b.robotPower > 100) {
        event({ event: "status_response_unrecognized" }); return;
      }
      const status = { robotState: b.robotState, robotPower: b.robotPower };
      for (const field of ["moveState", "chargeStage"]) if (typeof b[field] === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(b[field])) status[field] = b[field];
      if (b.robotPose && ["x", "y", "angle"].every((key) => Number.isFinite(b.robotPose[key]) && Math.abs(b.robotPose[key]) < 1000000)) {
        status.robotPose = Object.fromEntries(["x", "y", "angle"].map((key) => [key, b.robotPose[key]]));
      }
      event({ event: "robot_status_response_verified", status, poseUnitsVerified: false, motionCommandsEnabled: commandSupport });
      if (!includeMap) readBusyUntil = 0;
      if (includeMap && !destinationsRequestId) {
        destinationsRequestId = crypto.randomBytes(8).toString("hex");
        sendSetupMessage(`/${registeredNamespace}/user/sub_sdk`, {
          msgType: "request_data", msgId: destinationsRequestId, source: controllerId, target: data.source,
          body: { pageSize: 100, pageIndex: 1 },
        });
        event({ event: "destinations_read_sent", pageIndex: 1, pageSize: 100 });
      }
      return;
    }
    if (includeMap && destinationsRequestId && topic === `/${registeredNamespace}/user/pub_sdk` &&
        data?.msgType === "request_data" && data.msgId === destinationsRequestId && data.target === controllerId &&
        data.source === registeredNamespace.split("/")[1]) {
      const b = data.body;
      if (!Array.isArray(b?.destinations) || b.destinations.length > 100 || !Number.isInteger(b.total) || b.total < 0 || b.pageIndex !== 1 || b.pageSize !== 100) {
        event({ event: "destinations_response_unrecognized" }); return;
      }
      const validName = p => typeof p?.name === "string" && p.name.length > 0 && p.name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(p.name);
      const valid = p => validName(p) && typeof p.type === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(p.type);
      const destinations = b.destinations.filter(valid)
        .map(({name, type}) => ({name, type}));
      const rejected = b.destinations.filter(p => !valid(p)).map(p => ({
        ...(validName(p) ? { name: p.name } : {}),
        typeKind: typeof p?.type, typeLength: typeof p?.type === "string" ? p.type.length : null,
        emptyType: p?.type === "",
      }));
      event({ event: "robot_destinations_response_verified", total: b.total, destinations,
        rejected, complete: destinations.length === b.total, motionCommandsEnabled: commandSupport });
      if (!mapRequestId) {
        mapRequestId = crypto.randomBytes(8).toString("hex");
        sendSetupMessage(`/${registeredNamespace}/user/sub_sdk`, {
          msgType: "getRobotCurrentMap", msgId: mapRequestId, source: controllerId, target: data.source,
        });
        event({ event: "current_map_read_sent" });
      }
      return;
    }
    if (mapRead && mapRequestId && topic === `/${registeredNamespace}/user/pub_sdk` &&
        data?.msgType === "getRobotCurrentMap" && data.msgId === mapRequestId && data.target === controllerId &&
        data.source === registeredNamespace.split("/")[1]) {
      const encoded = data.body?.data;
      if (typeof encoded !== "string" || !encoded || encoded.length > MAX_PACKET || !/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) {
        event({ event: "current_map_response_empty_or_unrecognized" }); return;
      }
      try {
        // FileUtil.compress in the robot app is UTF-8 -> gzip -> Android Base64.
        const uncompressed = zlib.gunzipSync(Buffer.from(encoded, "base64"), { maxOutputLength: 8 * 1024 * 1024 });
        const text = decoder.decode(uncompressed);
        const document = JSON.parse(text);
        if (!document || typeof document !== "object") throw new Error("Invalid map document.");
        mapReceived(document);
        initialMapComplete = true;
        readBusyUntil = 0;
        event({ event: "current_map_response_verified", compressedBytes: Buffer.from(encoded, "base64").length,
          documentBytes: uncompressed.length, schemaVerified: false, motionCommandsEnabled: commandSupport });
      } catch { event({ event: "current_map_decode_failed" }); }
      return;
    }
    const match = /^\/shadow\/update\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})$/.exec(topic);
    if (!match) return;
    if (data?.method === "update") {
      const sdk = data.state?.reported?.authConfig?.sdk;
      if (Array.isArray(sdk) && registrationSent && `${match[1]}/${match[2]}` === registeredNamespace) {
        registered = sdk.some((item) => item?.id === controllerId);
        event({ event: "controller_configuration_reported", localControllerPresent: registered, controllerCount: sdk.length });
      }
      return;
    }
    if (data?.method !== "get" || registrationSent) return;
    const replyTopic = `/shadow/get/${match[1]}/${match[2]}`;
    if (!subscriptions.has(replyTopic)) return;
    // This is our new local server's desired runtime controller configuration.
    // No device credentials, existing controller IDs or group changes are used.
    // IotShadow.java merges desired.authConfig and reports it back in memory.
    const seconds = Math.floor(Date.now() / 1000);
    const response = {
      method: "reply", timestamp: seconds, version: 1,
      payload: { status: "success",
        state: { desired: { authConfig: { sdk: [{ id: controllerId, listener: commandSupport ? ["notifyGoState", "notifyCustomCall"] : [] }] } }, reported: {} },
        metadata: { desired: { authConfig: { timestamp: seconds } }, reported: {} },
      },
    };
    registrationSent = true;
    registeredNamespace = `${match[1]}/${match[2]}`;
    sendSetupMessage(replyTopic, response);
    event({ event: "local_controller_configuration_sent", topic: "/shadow/get/{product}/{device}", motionCommandsEnabled: commandSupport });
  }
  // Only these protocol acknowledgements can leave this observer.
  function ack(header, body) {
    if (![0x20, 0x40, 0x50, 0x70, 0x90, 0xb0, 0xd0].includes(header) || body.length > 127) {
      throw new Error("Observer cannot send application messages.");
    }
    write(Buffer.from([header, body.length, ...body]));
  }
  function packet(header, body) {
    const type = header >> 4;
    const flags = header & 15;
    if (type !== 3 && flags !== ([6, 8, 10].includes(type) ? 2 : 0)) {
      throw new Error("Invalid MQTT flags.");
    }
    const c = cursor(body);
    if (type === 1) {
      if (connected) throw new Error("Duplicate MQTT CONNECT.");
      const protocol = c.string();
      const level = c.byte();
      if (protocol !== "MQTT" || level !== 4) throw new Error("Expected MQTT 3.1.1.");
      const connectFlags = c.byte();
      const will = Boolean(connectFlags & 4);
      const willQos = (connectFlags >> 3) & 3;
      if (connectFlags & 1 || willQos === 3 || (!will && (connectFlags & 0x38)) ||
          ((connectFlags & 0x40) && !(connectFlags & 0x80))) throw new Error("Invalid MQTT CONNECT flags.");
      const seconds = c.uint16();
      const id = c.string();
      if (!id && !(connectFlags & 2)) throw new Error("Missing MQTT client identifier.");
      if (will) { c.string(); c.binary(); }
      if (connectFlags & 0x80) c.string();
      if (connectFlags & 0x40) c.binary();
      if (!c.done()) throw new Error("Trailing MQTT CONNECT data.");
      connected = true;
      keepAlive(seconds);
      ack(0x20, [0, 0]);
      event({ event: "mqtt_connected", protocol: "3.1.1", keepAliveSeconds: seconds,
        cleanSession: Boolean(connectFlags & 2), willIgnored: will });
      return;
    }
    if (!connected) throw new Error("MQTT CONNECT must be first.");
    if (type === 8 || type === 10) {
      const id = c.uint16();
      if (!id) throw new Error("Invalid MQTT packet identifier.");
      const topics = [];
      const granted = [];
      while (!c.done()) {
        const topic = c.string();
        if (!topic || topics.length >= 32) throw new Error("Invalid MQTT subscription list.");
        topics.push(topicShape(topic));
        if (type === 8) {
          if (!subscriptions.has(topic) && subscriptions.size >= 128) throw new Error("Too many MQTT subscriptions.");
          subscriptions.add(topic);
        } else subscriptions.delete(topic);
        if (type === 8) {
          const qos = c.byte();
          if (qos > 2) throw new Error("Invalid MQTT subscription QoS.");
          granted.push(qos);
        }
      }
      if (!topics.length) throw new Error("Empty MQTT subscription list.");
      ack(type === 8 ? 0x90 : 0xb0, [id >> 8, id & 255, ...granted]);
      event({ event: type === 8 ? "subscribed" : "unsubscribed", topics });
      return;
    }
    if (type === 3) {
      const qos = (flags >> 1) & 3;
      if (qos === 3 || (qos === 0 && (flags & 8))) throw new Error("Invalid MQTT publication QoS.");
      const topic = c.string();
      if (!topic || /[+#]/.test(topic)) throw new Error("Invalid MQTT publication topic.");
      const id = qos ? c.uint16() : 0;
      if (qos && !id) throw new Error("Invalid MQTT packet identifier.");
      const payload = c.rest();
      if (qos === 2) {
        if (!pendingQos2.has(id) && pendingQos2.size >= 128) throw new Error("Too many pending MQTT packets.");
        pendingQos2.add(id);
      }
      event({ event: "received_publication", topic: topicShape(topic), qos,
        retained: Boolean(flags & 1), payload: payloadShape(payload) });
      if (qos) ack(qos === 1 ? 0x40 : 0x50, [id >> 8, id & 255]);
      // A retained publication is historical, not a reply to this session.
      if (!(flags & 1)) localSetup(topic, payload);
      return;
    }
    if (type === 6) {
      const id = c.uint16();
      if (!id || !c.done()) throw new Error("Invalid MQTT PUBREL.");
      pendingQos2.delete(id);
      ack(0x70, [id >> 8, id & 255]);
      return;
    }
    if (type === 12 && body.length === 0) { ack(0xd0, []); return; }
    if (type === 14 && body.length === 0) {
      close();
      event({ event: "mqtt_disconnected" });
      end();
      return;
    }
    throw new Error("Unexpected MQTT packet.");
  }
  return {
    refreshReads,
    sendCommand,
    close,
    push(chunk) {
      if (ended) throw new Error("MQTT session ended.");
      if (buffered.length + chunk.length > MAX_PACKET + 5) throw new Error("MQTT input exceeds size limit.");
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2 && !ended) {
        let length = 0;
        let index = 1;
        let multiplier = 1;
        for (;;) {
          if (index >= buffered.length) return;
          const byte = buffered[index++];
          length += (byte & 127) * multiplier;
          if (length > MAX_PACKET || (index === 5 && (byte & 128))) throw new Error("MQTT packet exceeds size limit.");
          if (!(byte & 128)) {
            if (index > 2 && byte === 0) throw new Error("Invalid MQTT remaining length.");
            break;
          }
          multiplier *= 128;
        }
        if (buffered.length < index + length) return;
        const current = buffered.subarray(0, index + length);
        buffered = buffered.subarray(index + length);
        packet(current[0], current.subarray(index));
      }
    },
  };
}

function createObserver({ host, robot, pfx, passphrase, port = 8443, event = () => {}, controllerId = null, statusProbe = false, mapRead = false, commandSupport = false, mapReceived = () => {} }) {
  if (!localIPv4(host) || !localIPv4(robot)) throw new Error("Explicit private IPv4 addresses required.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid listener port.");
  const sockets = new Set();
  let activeSession = null;
  const server = tls.createServer({ pfx, passphrase, minVersion: "TLSv1.2", handshakeTimeout: 10000 }, (socket) => {
    if (socket.remoteAddress !== robot) { socket.destroy(); return; }
    event({ event: "tls_connected", protocol: socket.getProtocol() });
    socket.setTimeout(15000, () => socket.destroy());
    const session = createMqttSession({
      write: (data) => {
        if (socket.destroyed || !socket.writable || socket.writableLength > MAX_PACKET) { socket.destroy(); throw new Error("Socket unavailable."); }
        socket.write(data);
      },
      event,
      controllerId,
      statusProbe,
      mapRead,
      commandSupport,
      mapReceived,
      end: () => socket.end(),
      keepAlive: (seconds) => socket.setTimeout(seconds ? Math.min(900000, Math.max(3000, seconds * 1500)) : 120000),
    });
    activeSession = session;
    socket.on("data", (chunk) => {
      try { session.push(chunk); }
      catch { event({ event: "mqtt_packet_rejected" }); socket.destroy(); }
    });
    socket.on("error", () => event({ event: "socket_error" }));
    socket.on("close", () => {
      session.close();
      if (activeSession === session) activeSession = null;
      event({ event: "connection_closed" });
    });
  });
  server.on("connection", (socket) => {
    if (socket.remoteAddress !== robot || sockets.size >= 1) { socket.destroy(); return; }
    sockets.add(socket);
    event({ event: "tcp_connected" });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  server.on("tlsClientError", () => event({ event: "tls_handshake_failed" }));
  return {
    server,
    refreshReads: (options) => activeSession?.refreshReads(options) || false,
    sendCommand: command => {
      if (!activeSession) throw new Error("Bella is disconnected.");
      return activeSession.sendCommand(command);
    },
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.removeListener("error", reject); resolve(server.address()); });
    }),
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }),
  };
}

module.exports = { createMqttSession, createObserver, topicShape, payloadShape, MAX_PACKET };
