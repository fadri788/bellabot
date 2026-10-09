"use strict";

// Pure, validated request bodies for Bella's Local API command messages. No sockets, no publish.
// Wire names: extracted PuduRobotOpenServer app/pddevice/{const,protocols}.js. Body shapes: robot
// beans in public decompiled BellaBot 6.12.0.10 (CallBody, CustomCallBody, CustomCallContentData, ...).
// Numeric ranges: official Pudu open-platform custom_call docs. See ../README.md for scope and references.
// Supported operations still require a supervised test on each robot and firmware version.

const MSG_TYPES = Object.freeze({
  call: "call",
  cancelCall: "cancelCall",
  customCall: "customCall",
  customCallCancel: "customCallCancel",
  customCallContent: "customCallContent",
  customCallComplete: "customCallComplete",
});

// CustomCallContract.CustomCallBodyType enum names (sent via .name()). callConfirm and call carry no
// content and change what happens on completion, so they are deliberately not built here.
const CONTENT_TYPES = Object.freeze(["img", "qrcode", "video"]);

// Local safety caps, not source limits.
const MAX_URLS = 10;
const MAX_URL_LENGTH = 2048;
const MAX_QR_LENGTH = 1024;
const MAX_TEXT_LENGTH = 200;

function fail(message) {
  throw new Error(message);
}

function checkName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) {
    fail("Destination name must be a non-empty string of at most 128 characters without control characters.");
  }
}

// The robot matches destinations by exact name (RobotMapManager.checkDestinationExist) and parses
// {name, type}. Take both from a verified request_data list so no name or type is guessed.
function destinationFrom(name, destinations) {
  checkName(name);
  if (!Array.isArray(destinations)) fail("Pass the verified request_data destination list.");
  const matches = destinations.filter((d) => d && d.name === name);
  if (matches.length !== 1) fail(`Destination "${name}" must appear exactly once in the verified list.`);
  const { type } = matches[0];
  if (typeof type !== "string" || !/^[A-Za-z0-9_]{0,32}$/.test(type)) fail(`Destination "${name}" has an unrecognized type.`);
  return { name, type };
}

function isTaskId(taskId) {
  return typeof taskId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(taskId);
}

function checkTaskId(taskId) {
  if (!isTaskId(taskId)) {
    fail("taskId must be the non-empty id returned by the robot's customCall reply.");
  }
}

function checkKeys(object, allowed, label) {
  if (!object || typeof object !== "object" || Array.isArray(object)) fail(`${label} must be an object.`);
  for (const key of Object.keys(object)) if (!allowed.includes(key)) fail(`${label} has unsupported field "${key}".`);
}

function optionalInt(value, label, isValid, rule) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value > 2147483647 || !isValid(value)) {
    fail(`${label} must be a signed 32-bit integer ${rule}.`);
  }
  return value;
}

function checkUrls(urls) {
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_URLS) fail(`urls must list 1 to ${MAX_URLS} addresses.`);
  return urls.map((u) => {
    if (typeof u !== "string" || u.length > MAX_URL_LENGTH) fail("Each url must be a string.");
    let parsed;
    try { parsed = new URL(u); } catch { fail("Invalid content URL."); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail("urls must use http or https.");
    if (parsed.username || parsed.password) fail("urls must not embed credentials.");
    return u;
  });
}

const cancelBtnRule = [(v) => v >= -1, ">= -1 (-1 hides the cancel button, 0 shows it immediately)"];

// Returns {contentType, contentData} with only the fields the robot reads for that type
// (CustomCallPresenter builds CustomCallImgBean / CustomCallQrcodeBean / CustomCallVideoBean).
function buildContent(content) {
  if (!content || typeof content !== "object") fail("content must be an object with a contentType.");
  const { contentType } = content;
  if (!CONTENT_TYPES.includes(contentType)) fail(`contentType must be one of: ${CONTENT_TYPES.join(", ")}.`);
  let contentData;
  if (contentType === "img") {
    checkKeys(content, ["contentType", "urls", "switchTime", "cancelBtnTime", "showTimeout"], "img content");
    contentData = {
      urls: checkUrls(content.urls),
      switchTime: optionalInt(content.switchTime, "switchTime", (v) => v >= 2, ">= 2 seconds"),
      cancelBtnTime: optionalInt(content.cancelBtnTime, "cancelBtnTime", ...cancelBtnRule),
      showTimeout: optionalInt(content.showTimeout, "showTimeout", (v) => v === -1 || v >= 1, "of -1 (never auto-end) or >= 1 second"),
    };
  } else if (contentType === "video") {
    checkKeys(content, ["contentType", "urls", "playCount", "cancelBtnTime"], "video content");
    contentData = {
      urls: checkUrls(content.urls),
      playCount: optionalInt(content.playCount, "playCount", (v) => v >= 1, ">= 1"),
      cancelBtnTime: optionalInt(content.cancelBtnTime, "cancelBtnTime", ...cancelBtnRule),
    };
  } else {
    checkKeys(content, ["contentType", "qrcode", "text"], "qrcode content");
    if (typeof content.qrcode !== "string" || content.qrcode.length === 0 || content.qrcode.length > MAX_QR_LENGTH) {
      fail(`qrcode must be a non-empty string of at most ${MAX_QR_LENGTH} characters.`);
    }
    if (content.text !== undefined && (typeof content.text !== "string" || content.text.length > MAX_TEXT_LENGTH)) {
      fail(`text must be a string of at most ${MAX_TEXT_LENGTH} characters.`);
    }
    contentData = { qrcode: content.qrcode, text: content.text };
  }
  for (const key of Object.keys(contentData)) if (contentData[key] === undefined) delete contentData[key];
  return { contentType, contentData };
}

function buildCall(name, destinations) {
  return { msgType: MSG_TYPES.call, body: { destination: destinationFrom(name, destinations) } };
}

// The robot always replies success to cancelCall and cancels this controller's pending/running calls.
// The reply does not prove the robot stopped, and cancelCall is not an emergency stop.
function buildCancelCall(name, destinations) {
  return { msgType: MSG_TYPES.cancelCall, body: { destination: destinationFrom(name, destinations) } };
}

function customCallBody(name, destinations, content) {
  return { destination: destinationFrom(name, destinations), ...buildContent(content) };
}

function buildCustomCall(name, destinations, content) {
  return { msgType: MSG_TYPES.customCall, body: customCallBody(name, destinations, content) };
}

// Robot accepts this only while the custom call state is Arrived and taskId matches.
function buildCustomCallContent(taskId, content) {
  checkTaskId(taskId);
  return { msgType: MSG_TYPES.customCallContent, body: { ...buildContent(content), taskId } };
}

// Without next, completion sends the robot to its turn-back (return) screen. next = {name, destinations, content}.
function buildCustomCallComplete(taskId, next) {
  checkTaskId(taskId);
  const body = { taskId };
  if (next !== undefined) {
    checkKeys(next, ["name", "destinations", "content"], "next");
    body.nextCallTask = customCallBody(next.name, next.destinations, next.content);
  }
  return { msgType: MSG_TYPES.customCallComplete, body };
}

// An empty taskId cancels whichever custom call the robot holds; only allowed when explicitly requested,
// e.g. to clear a task id the robot kept after a rejected customCall.
function buildCustomCallCancel(taskId, { allowAnyTask = false } = {}) {
  if (taskId === "" && allowAnyTask === true) return { msgType: MSG_TYPES.customCallCancel, body: { taskId: "" } };
  checkTaskId(taskId);
  return { msgType: MSG_TYPES.customCallCancel, body: { taskId } };
}

// Reply codes: call from robot ErrorCode/onEvent$1 and server _callRobot; customCall from server
// customCallByDevice (the 6.12.0.10 robot replies false without a code).
const REPLY_CODES = Object.freeze({
  call: { 10001: "destination not on the robot's current map", 10002: "robot API call switch is off", 10003: "destination already called by another controller" },
  customCall: { 21001: "destination not on the robot's current map", 21002: "robot busy or cannot run a custom call" },
});

function interpretReply(msgType, body) {
  if (!Object.values(MSG_TYPES).includes(msgType)) fail(`Unsupported msgType ${msgType}.`);
  if (!body || typeof body.success !== "boolean") return { recognized: false };
  const code = Number.isInteger(body.code) ? body.code : undefined;
  const result = { recognized: true, accepted: body.success, code };
  const reason = code !== undefined ? REPLY_CODES[msgType]?.[code] : undefined;
  if (reason) result.reason = reason;
  if (msgType === MSG_TYPES.customCall && body.success) {
    if (!isTaskId(body.taskId)) return { recognized: false };
    result.taskId = body.taskId;
  }
  if (msgType === MSG_TYPES.customCallComplete && body.nextTaskResult && typeof body.nextTaskResult.success === "boolean") {
    if ((body.nextTaskResult.success || body.nextTaskResult.taskId !== undefined) && !isTaskId(body.nextTaskResult.taskId)) {
      return { recognized: false };
    }
    result.nextTaskAccepted = body.nextTaskResult.success;
    if (isTaskId(body.nextTaskResult.taskId)) result.nextTaskId = body.nextTaskResult.taskId;
  }
  if (msgType === MSG_TYPES.cancelCall) result.note = "acknowledged only; confirm the stop with fresh state";
  return result;
}

// notifyCustomCall body: PubCustomCallData {state, destinationName, operationType, taskId}.
const CUSTOM_CALL_STATES = Object.freeze(["Arriving", "Arrived", "Cancel", "Complete", "Pause"]);
const CUSTOM_CALL_OPERATIONS = Object.freeze(["remote", "timeout", "user"]);

function parseCustomCallNotification(body) {
  if (!body || !CUSTOM_CALL_STATES.includes(body.state) || !isTaskId(body.taskId) ||
      !CUSTOM_CALL_OPERATIONS.includes(body.operationType)) {
    return { recognized: false };
  }
  try { checkName(body.destinationName); } catch { return { recognized: false }; }
  return { recognized: true, state: body.state, destinationName: body.destinationName,
    operationType: body.operationType, taskId: body.taskId, finished: body.state === "Cancel" || body.state === "Complete" };
}

module.exports = {
  MSG_TYPES, CONTENT_TYPES, CUSTOM_CALL_STATES, CUSTOM_CALL_OPERATIONS, REPLY_CODES,
  buildCall, buildCancelCall, buildCustomCall, buildCustomCallContent, buildCustomCallComplete, buildCustomCallCancel,
  interpretReply, parseCustomCallNotification,
};
