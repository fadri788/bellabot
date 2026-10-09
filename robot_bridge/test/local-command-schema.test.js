"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const s = require("../src/local-command-schema");

// Synthetic fixture based on captured table records, plus a source-derived empty-type case.
// The dropped Start/Return response has not been captured directly on this robot.
const DESTINATIONS = [
  { name: "ABB YuMi", type: "table" },
  { name: "Kitchen", type: "table" },
  { name: "Start/Return", type: "" },
];
const TASK = "3f2c9a4e-1b7d-4c0e-9a55-2d6f8e1b7c30";

test("call and cancelCall send the destination object taken from the verified list", () => {
  assert.deepEqual(s.buildCall("ABB YuMi", DESTINATIONS),
    { msgType: "call", body: { destination: { name: "ABB YuMi", type: "table" } } });
  assert.deepEqual(s.buildCancelCall("Kitchen", DESTINATIONS),
    { msgType: "cancelCall", body: { destination: { name: "Kitchen", type: "table" } } });
  assert.deepEqual(s.buildCall("Start/Return", DESTINATIONS).body.destination, { name: "Start/Return", type: "" });
});

test("unknown, duplicate or malformed destinations are rejected", () => {
  assert.throws(() => s.buildCall("Meeting 99", DESTINATIONS), /exactly once/);
  assert.throws(() => s.buildCall("Kitchen", [...DESTINATIONS, { name: "Kitchen", type: "table" }]), /exactly once/);
  assert.throws(() => s.buildCall("Kitchen"), /verified request_data/);
  assert.throws(() => s.buildCall("", DESTINATIONS), /non-empty/);
  assert.throws(() => s.buildCall("x\n", [{ name: "x\n", type: "table" }]), /control/);
  assert.throws(() => s.buildCall("Bad", [{ name: "Bad", type: "ta ble" }]), /unrecognized type/);
});

test("customCall image body matches CustomCallBody/CustomCallContentData", () => {
  const msg = s.buildCustomCall("ABB YuMi", DESTINATIONS, {
    contentType: "img", urls: ["http://192.0.2.48:8081/logo.png"], switchTime: 5, cancelBtnTime: -1, showTimeout: 60,
  });
  assert.deepEqual(msg, {
    msgType: "customCall",
    body: {
      destination: { name: "ABB YuMi", type: "table" },
      contentType: "img",
      contentData: { urls: ["http://192.0.2.48:8081/logo.png"], switchTime: 5, cancelBtnTime: -1, showTimeout: 60 },
    },
  });
  const minimal = s.buildCustomCall("Kitchen", DESTINATIONS, { contentType: "img", urls: ["https://example.test/a.png"] });
  assert.deepEqual(minimal.body.contentData, { urls: ["https://example.test/a.png"] });
});

test("customCall QR code and video bodies carry only the fields the robot reads", () => {
  assert.deepEqual(s.buildCustomCall("Kitchen", DESTINATIONS, { contentType: "qrcode", qrcode: "https://example.test", text: "Scan me" }).body,
    { destination: { name: "Kitchen", type: "table" }, contentType: "qrcode", contentData: { qrcode: "https://example.test", text: "Scan me" } });
  assert.deepEqual(s.buildCustomCall("Kitchen", DESTINATIONS, { contentType: "video", urls: ["http://10.0.0.2/v.mp4"], playCount: 1 }).body.contentData,
    { urls: ["http://10.0.0.2/v.mp4"], playCount: 1 });
});

test("content outside the documented ranges or types is rejected", () => {
  const img = (extra) => s.buildCustomCall("Kitchen", DESTINATIONS, { contentType: "img", urls: ["http://10.0.0.2/a.png"], ...extra });
  assert.throws(() => img({ switchTime: 1 }), /switchTime/);
  assert.throws(() => img({ cancelBtnTime: -2 }), /cancelBtnTime/);
  assert.throws(() => img({ showTimeout: 0 }), /showTimeout/);
  assert.throws(() => img({ showTimeout: 1.5 }), /showTimeout/);
  assert.throws(() => img({ showTimeout: 2147483648 }), /32-bit/);
  assert.throws(() => img({ switchTime: Number.MAX_SAFE_INTEGER }), /32-bit/);
  assert.throws(() => img({ playCount: 1 }), /unsupported field "playCount"/);
  assert.throws(() => s.buildCustomCall("Kitchen", DESTINATIONS, { contentType: "img", urls: [] }), /urls/);
  assert.throws(() => s.buildCustomCall("Kitchen", DESTINATIONS, { contentType: "img", urls: ["file:///c:/a.png"] }), /http/);
  assert.throws(() => s.buildCustomCall("Kitchen", DESTINATIONS, { contentType: "img", urls: ["http://u:p@10.0.0.2/a.png"] }), /credentials/);
  assert.throws(() => s.buildCustomCall("Kitchen", DESTINATIONS, { contentType: "qrcode", qrcode: "" }), /qrcode/);
  assert.throws(() => s.buildCustomCall("Kitchen", DESTINATIONS, { contentType: "video", urls: ["http://a.test/v.mp4"], showTimeout: 5 }), /unsupported/);
  for (const contentType of ["callConfirm", "call", "IMG", undefined]) {
    assert.throws(() => s.buildCustomCall("Kitchen", DESTINATIONS, { contentType }), /contentType/);
  }
});

test("follow-up custom call messages require the robot's task id", () => {
  assert.deepEqual(s.buildCustomCallContent(TASK, { contentType: "qrcode", qrcode: "abc" }),
    { msgType: "customCallContent", body: { contentType: "qrcode", contentData: { qrcode: "abc" }, taskId: TASK } });
  assert.deepEqual(s.buildCustomCallComplete(TASK), { msgType: "customCallComplete", body: { taskId: TASK } });
  assert.deepEqual(s.buildCustomCallComplete(TASK, { name: "Kitchen", destinations: DESTINATIONS, content: { contentType: "qrcode", qrcode: "x" } }).body,
    { taskId: TASK, nextCallTask: { destination: { name: "Kitchen", type: "table" }, contentType: "qrcode", contentData: { qrcode: "x" } } });
  assert.deepEqual(s.buildCustomCallCancel(TASK), { msgType: "customCallCancel", body: { taskId: TASK } });
  assert.throws(() => s.buildCustomCallContent("", { contentType: "qrcode", qrcode: "abc" }), /taskId/);
  assert.throws(() => s.buildCustomCallComplete(undefined), /taskId/);
  assert.throws(() => s.buildCustomCallCancel(""), /taskId/);
  assert.throws(() => s.buildCustomCallComplete(TASK, { name: "Kitchen", destinations: DESTINATIONS, content: { contentType: "qrcode", qrcode: "x" }, extra: 1 }), /unsupported/);
  assert.deepEqual(s.buildCustomCallCancel("", { allowAnyTask: true }), { msgType: "customCallCancel", body: { taskId: "" } });
});

test("builders are pure and return fresh objects", () => {
  const list = JSON.parse(JSON.stringify(DESTINATIONS));
  const a = s.buildCall("Kitchen", list);
  a.body.destination.name = "changed";
  assert.deepEqual(list, DESTINATIONS);
  assert.equal(s.buildCall("Kitchen", list).body.destination.name, "Kitchen");
});

test("replies are interpreted from the documented codes without over-claiming", () => {
  assert.deepEqual(s.interpretReply("call", { success: false, code: 10002 }),
    { recognized: true, accepted: false, code: 10002, reason: "robot API call switch is off" });
  assert.equal(s.interpretReply("cancelCall", { success: true }).note, "acknowledged only; confirm the stop with fresh state");
  assert.deepEqual(s.interpretReply("customCall", { success: true, taskId: TASK }), { recognized: true, accepted: true, code: undefined, taskId: TASK });
  assert.deepEqual(s.interpretReply("customCall", { success: true }), { recognized: false });
  assert.deepEqual(s.interpretReply("customCall", { success: false }), { recognized: true, accepted: false, code: undefined });
  assert.deepEqual(s.interpretReply("customCallComplete", { success: true, nextTaskResult: { success: true, taskId: TASK } }),
    { recognized: true, accepted: true, code: undefined, nextTaskAccepted: true, nextTaskId: TASK });
  assert.deepEqual(s.interpretReply("call", null), { recognized: false });
  assert.throws(() => s.interpretReply("completeCall", { success: true }), /Unsupported/);
});

test("notifyCustomCall events are parsed strictly", () => {
  assert.deepEqual(s.parseCustomCallNotification({ state: "Complete", destinationName: "Kitchen", operationType: "timeout", taskId: TASK }),
    { recognized: true, state: "Complete", destinationName: "Kitchen", operationType: "timeout", taskId: TASK, finished: true });
  assert.equal(s.parseCustomCallNotification({ state: "Arrived", destinationName: "Kitchen", operationType: "remote", taskId: TASK }).finished, false);
  assert.deepEqual(s.parseCustomCallNotification({ state: "Done", destinationName: "Kitchen", operationType: "user", taskId: TASK }), { recognized: false });
});

test("untrusted reply and event identifiers stay bounded and invalid URLs are not echoed", () => {
  const event = { state: "Arrived", destinationName: "Kitchen", operationType: "remote", taskId: TASK };
  for (const invalid of ["", "x".repeat(65), "x\nsecret"]) {
    assert.deepEqual(s.parseCustomCallNotification({ ...event, taskId: invalid }), { recognized: false });
    assert.deepEqual(s.interpretReply("customCallComplete", { success: true, nextTaskResult: { success: true, taskId: invalid } }), { recognized: false });
  }
  for (const invalid of ["", "x".repeat(129), "Kitchen\nsecret"]) {
    assert.deepEqual(s.parseCustomCallNotification({ ...event, destinationName: invalid }), { recognized: false });
  }
  assert.deepEqual(s.interpretReply("customCallComplete", { success: true, nextTaskResult: { success: true } }), { recognized: false });
  assert.throws(() => s.buildCustomCall("Kitchen", DESTINATIONS, { contentType: "img", urls: ["private-invalid-content-value"] }),
    (error) => error.message === "Invalid content URL.");
});
