"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalControl } = require("../src/local-control");
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  let clock = Date.now();
  const s = { connected: true, registered: true, fresh: true, statusAt: new Date(clock).toISOString(),
    status: { robotState: "Free", moveState: "Idle", chargeStage: "Idle" }, mapAt: new Date(clock).toISOString(), mapPending: false,
    map: { id: "a".repeat(64), elements: [{ type: "source", name: "Kitchen" }, { type: "source", name: "Entrance" }] },
    destinations: [{ name: "Kitchen", type: "table" }, { name: "Entrance", type: "table" }] };
  const sent = []; let resolve;
  const control = createLocalControl({ snapshot: () => s, enabled: true, now: () => clock,
    sendCommand: command => { sent.push(command); return new Promise(r => { resolve = r; }); }, ...options });
  const input = (action = "go") => ({ id: crypto.randomUUID(), action, destination: "Kitchen", mapId: s.map.id,
    confirmation: { besideRobot: true, correctMapAndPosition: true, clearPathAndStopReady: true },
    ...(action === "screen" ? { content: { contentType: "qrcode", qrcode: "hello" } } : {}) });
  return { s, sent, control, input, reply: value => resolve(value), advance: ms => { clock += ms; s.statusAt = new Date(clock).toISOString(); } };
}
test("control defaults off and requires real freshness, map, idle state and explicit supervision", () => {
  const h = harness({ enabled: false }); assert.throws(() => h.control.execute(h.input()), /disabled/); assert.equal(h.sent.length, 0);
  for (const mutate of [h=>h.s.fresh=false, h=>h.s.statusAt="2020-01-01", h=>h.s.status.robotState="Busy", h=>h.s.status.moveState="Moving",
    h=>h.s.status.chargeStage="Charging", h=>h.s.mapPending=true, h=>h.s.mapAt="2020-01-01", h=>h.s.destinations[0].type="",
    h=>h.s.map.elements.push(h.s.map.elements[0])]) {
    const h = harness(); mutate(h); assert.throws(() => h.control.execute(h.input())); assert.equal(h.sent.length, 0);
  }
  const good = harness(), request = good.input(); request.confirmation.besideRobot=false;
  assert.throws(()=>good.control.execute(request),/beside/);
  request.confirmation.besideRobot=true; request.mapId="bad"; assert.throws(()=>good.control.execute(request),/map/);
});
test("status freshness rejects missing, invalid, future and expired timestamps", () => {
  for (const offset of [undefined, "invalid", 1, -18000]) {
    const h = harness();
    h.s.statusAt = typeof offset === "number" ? new Date(Date.parse(h.s.statusAt) + offset).toISOString() : offset;
    assert.equal(h.control.snapshot().ready, false);
    assert.throws(() => h.control.execute(h.input()), /fresh connection/);
    assert.equal(h.sent.length, 0);
  }
  const h = harness(); h.s.statusAt = new Date(Date.parse(h.s.statusAt) - 17999).toISOString();
  h.control.execute(h.input()); assert.equal(h.sent.length, 1);
});
test("map freshness rejects missing, invalid, future and expired timestamps", () => {
  for (const offset of [undefined, "invalid", 1, -120001]) {
    const h = harness();
    h.s.mapAt = typeof offset === "number" ? new Date(Date.parse(h.s.mapAt) + offset).toISOString() : offset;
    assert.throws(() => h.control.execute(h.input()), /Refresh Bella's map/);
    assert.equal(h.sent.length, 0);
  }
  const h = harness(); h.s.mapAt = new Date(Date.parse(h.s.mapAt) - 120000).toISOString();
  h.control.execute(h.input()); assert.equal(h.sent.length, 1);
});
test("one dispatch is durable before transport, duplicates never resend, and a timeout remains locked", async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"bella-control-")); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const journalPath=path.join(dir,"journal.json"); const h=harness({journalPath}); const request=h.input();
  h.control.execute(request);
  assert.equal(JSON.parse(fs.readFileSync(journalPath)).active.phase,"sending");
  assert.equal(h.control.execute(request).duplicate,true); assert.equal(h.sent.length,1);
  assert.throws(()=>h.control.execute({...request,destination:"Entrance"}),/already used/);
  h.reply({outcome:"unknown",reason:"timeout"}); await flush();
  assert.equal(h.control.snapshot().active.phase,"unknown"); assert.throws(()=>h.control.execute(h.input()),/current task/);
  const next=harness({journalPath}); assert.equal(next.control.snapshot().active.phase,"unknown");
  assert.equal(next.control.execute(request).duplicate,true); assert.equal(next.sent.length,0);
  const clear=next.input("reconcile"); clear.confirmation.robotTaskCleared=true; next.advance(5000);
  next.control.execute(clear); assert.equal(next.control.snapshot().active,null); assert.equal(next.sent.length,0);
});
test("corrupt or unwritable journal prevents dispatch", t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"bella-history-")); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,"history.json"); fs.writeFileSync(file,"broken");
  const bad=harness({journalPath:file}); assert.throws(()=>bad.control.execute(bad.input()),/disabled/); assert.equal(bad.sent.length,0);
  const noWrite=harness({journalPath:path.join(dir,"missing","history.json")});
  assert.throws(()=>noWrite.control.execute(noWrite.input()),/history/); assert.equal(noWrite.sent.length,0);
});
test("custom task ids and arrival notifications gate screen changes; completion requires return check", async () => {
  const h=harness(); h.control.execute(h.input("screen")); h.reply({outcome:"accepted",taskId:"task-123"}); await flush();
  const update=h.input("update"); update.content={contentType:"qrcode",qrcode:"new"};
  assert.throws(()=>h.control.execute(update),/Arrived/);
  h.control.event({event:"robot_task_notification",kind:"customCall",notification:{state:"Arrived",taskId:"wrong",destinationName:"Kitchen"}});
  assert.equal(h.control.snapshot().active.phase,"accepted");
  h.control.event({event:"robot_task_notification",kind:"customCall",notification:{state:"Arrived",taskId:"task-123",destinationName:"Kitchen"}});
  assert.equal(h.control.snapshot().active.phase,"Arrived");
  h.s.status.robotState="Busy";
  h.control.execute(update); assert.equal(h.sent.at(-1).msgType,"customCallContent"); assert.equal(h.sent.at(-1).body.taskId,"task-123");
  h.reply({outcome:"accepted"}); await flush();
  const finish=h.input("finish"); assert.throws(()=>h.control.execute(finish),/return/);
  finish.confirmation.returnPathChecked=true; h.control.execute(finish); h.reply({outcome:"accepted"}); await flush();
  assert.equal(h.control.snapshot().active.phase,"check-robot");
});
test("picture/video defaults, rejected custom tasks and disconnects cannot silently unlock or advance", async () => {
  const h=harness(), input=h.input("screen"); input.content={contentType:"img",urls:["http://192.0.2.12/media/p.png"]};
  assert.throws(()=>h.control.execute(input),/without a timeout/);
  input.content={contentType:"video",urls:["http://192.0.2.12/media/v.mp4"],playCount:1};
  assert.throws(()=>h.control.execute(input),/return/);
  input.confirmation.returnPathChecked=true; h.control.execute(input); h.reply({outcome:"rejected"}); await flush();
  assert.equal(h.control.snapshot().active.phase,"check-robot");
  h.control.event({event:"connection_closed"}); assert.equal(h.control.snapshot().active.phase,"unknown"); assert.equal(h.sent.length,1);
});
test("a plain call acceptance and cancellation are never displayed as proof of arriving or stopping", async () => {
  const h=harness(); h.control.execute(h.input()); h.reply({outcome:"accepted"}); await flush();
  assert.equal(h.control.snapshot().active.phase,"accepted");
  h.s.status.robotState="Busy"; h.s.status.moveState="Moving";
  h.control.execute(h.input("cancel")); assert.equal(h.sent.at(-1).msgType,"cancelCall"); h.reply({outcome:"accepted"}); await flush();
  assert.equal(h.control.snapshot().active.phase,"check-robot");
  const clear=h.input("reconcile"); clear.confirmation.robotTaskCleared=true; h.advance(5000);
  assert.throws(()=>h.control.execute(clear),/stationary/); assert.equal(h.sent.length,2);
});
test("guided custom routines advance only on an explicit next action with a returned next task id", async () => {
  const h=harness(); h.control.execute(h.input("screen")); h.reply({outcome:"accepted",taskId:"first-task"}); await flush();
  h.control.event({event:"robot_task_notification",kind:"customCall",notification:{state:"Arrived",taskId:"first-task",destinationName:"Kitchen"}});
  assert.equal(h.sent.length,1,"Arrival cannot send the next stop");
  h.s.status.robotState="Busy";h.s.status.moveState="Arrive";
  const next=h.input("next");next.destination="Entrance";next.content={contentType:"qrcode",qrcode:"next stop"};
  h.control.execute(next);assert.equal(h.sent.at(-1).body.taskId,"first-task");assert.equal(h.sent.at(-1).body.nextCallTask.destination.name,"Entrance");
  h.reply({outcome:"accepted",nextTaskAccepted:true,nextTaskId:"second-task"});await flush();
  assert.equal(h.control.snapshot().active.destination.name,"Entrance");assert.equal(h.control.snapshot().active.taskId,"second-task");
  h.control.event({event:"robot_task_notification",kind:"customCall",notification:{state:"Arrived",taskId:"first-task",destinationName:"Kitchen"}});
  assert.equal(h.control.snapshot().active.phase,"accepted");assert.equal(h.sent.length,2);
});
test("an arrival preceding the custom task reply is matched after the task id arrives",async()=>{
  const h=harness();h.control.execute(h.input("screen"));
  h.control.event({event:"robot_task_notification",kind:"customCall",notification:{state:"Arrived",taskId:"early-task",destinationName:"Kitchen"}});
  h.reply({outcome:"accepted",taskId:"early-task"});await flush();
  assert.equal(h.control.snapshot().active.phase,"Arrived");assert.equal(h.sent.length,1);
});
test("connection loss stays unknown after a late reply and buffered arrival", async () => {
  for (const event of ["connection_closed", "mqtt_disconnected", "listener_stopped"]) {
    for (const outcome of ["accepted", "rejected"]) {
      const h = harness(); const input = h.input(); h.control.execute(input);
      h.control.event({ event: "robot_task_notification", kind: "call", notification: { state: "Arrived", destinationName: "Kitchen", destinationType: "table" } });
      h.control.event({ event });
      h.reply({ outcome }); await flush();
      assert.equal(h.control.snapshot().busy, false);
      assert.equal(h.control.snapshot().active.phase, "unknown");
      assert.match(h.control.snapshot().active.note, /Connection lost/);
      assert.equal(h.control.execute(input).outcome, outcome);
      assert.throws(() => h.control.execute(h.input()), /current task/);
      assert.equal(h.sent.length, 1);
    }
  }
});
test("a late custom reply retains its task id after connection loss without allowing screen updates", async () => {
  const h = harness(); h.control.execute(h.input("screen"));
  h.control.event({ event: "connection_closed" });
  h.control.event({ event: "robot_task_notification", kind: "customCall", notification: { state: "Arrived", taskId: "late-task", destinationName: "Kitchen" } });
  h.reply({ outcome: "accepted", taskId: "late-task" }); await flush();
  assert.equal(h.control.snapshot().active.taskId, "late-task");
  assert.equal(h.control.snapshot().active.phase, "unknown");
  const update = h.input("update"); update.content = { contentType: "qrcode", qrcode: "new" };
  assert.throws(() => h.control.execute(update), /Arrived/);
  assert.equal(h.sent.length, 1);
});
test("a next-task reply after connection loss records the new task but keeps it unknown", async () => {
  const h = harness(); h.control.execute(h.input("screen")); h.reply({ outcome: "accepted", taskId: "first-task" }); await flush();
  h.control.event({ event: "robot_task_notification", kind: "customCall", notification: { state: "Arrived", taskId: "first-task", destinationName: "Kitchen" } });
  const next = h.input("next"); next.destination = "Entrance"; next.content = { contentType: "qrcode", qrcode: "next" };
  h.control.execute(next); h.control.event({ event: "mqtt_disconnected" });
  h.reply({ outcome: "accepted", nextTaskAccepted: true, nextTaskId: "second-task" }); await flush();
  assert.equal(h.control.snapshot().active.destination.name, "Entrance");
  assert.equal(h.control.snapshot().active.taskId, "second-task");
  assert.equal(h.control.snapshot().active.phase, "unknown");
  assert.equal(h.sent.length, 2);
});
