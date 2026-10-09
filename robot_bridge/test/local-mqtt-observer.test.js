"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { createMqttSession, topicShape, payloadShape, MAX_PACKET } = require("../src/local-mqtt-observer");

function field(value) {
  const text = Buffer.from(value);
  return Buffer.concat([Buffer.from([text.length >> 8, text.length & 255]), text]);
}
function packet(header, body = Buffer.alloc(0)) {
  let length = body.length;
  const bytes = [];
  do { const next = length % 128; length = Math.floor(length / 128); bytes.push(next | (length ? 128 : 0)); } while (length);
  return Buffer.concat([Buffer.from([header, ...bytes]), body]);
}
function connect() {
  // Includes credentials and a will. None may reach logs or get replayed.
  return packet(0x10, Buffer.concat([field("MQTT"), Buffer.from([4, 0xc6, 0, 30]),
    field("private-device-id"), field("private/will/topic"), field("private-will-data"),
    field("private-username"), field("private-password")]));
}
function harness() {
  const writes = [];
  const events = [];
  let ended = false;
  const session = createMqttSession({ write: (data) => writes.push(data), event: (data) => events.push(data), end: () => { ended = true; } });
  return { session, writes, events, ended: () => ended };
}

function commandHarness(extra={}) {
  const id="pudu-laptop-1234567812345678",writes=[],events=[];
  const session=createMqttSession({write:p=>writes.push(p),event:e=>events.push(e),controllerId:id,commandSupport:true,...extra});
  const publish=(body,topic="/product/device/user/pub_sdk")=>session.push(packet(0x30,Buffer.concat([field(topic),Buffer.from(JSON.stringify(body))])));
  session.push(connect());
  session.push(packet(0x82,Buffer.concat([Buffer.from([0,1]),...["/shadow/get/product/device","/product/device/user/sub_sdk"].flatMap(t=>[field(t),Buffer.from([0])])])));
  publish({method:"get"},"/shadow/update/product/device");
  publish({method:"update",state:{reported:{authConfig:{sdk:[{id}]}}}},"/shadow/update/product/device");
  const last=()=>{const p=writes.at(-1);let i=1;while(p[i++]&128){}const size=p.readUInt16BE(i);i+=2;return JSON.parse(p.subarray(i+size));};
  return {session,writes,events,publish,id,last};
}
test("command transport is opt-in, matches every reply identity and never repeats a timeout",async()=>{
  const off=commandHarness({commandSupport:false});assert.throws(()=>off.session.sendCommand({msgType:"call",body:{}}),/not ready/);
  const h=commandHarness({commandTimeoutMs:50});
  const pending=h.session.sendCommand({msgType:"call",body:{destination:{name:"Kitchen",type:"table"}}});
  const request=h.last(),count=h.writes.length;
  assert.throws(()=>h.session.sendCommand({msgType:"call",body:{}}),/pending/);
  const response={msgId:request.msgId,msgType:"call",source:"device",target:h.id,body:{success:true}};
  h.publish({...response,source:"other"});h.publish({...response,target:"other"});h.publish({...response,msgId:"wrong"});h.publish(response,"/product/other/user/pub_sdk");
  assert.equal((await pending).outcome,"unknown");assert.equal(h.writes.length,count);
  const next=h.session.sendCommand({msgType:"call",body:{destination:{name:"Kitchen",type:"table"}}});
  h.publish({...response,msgId:h.last().msgId});assert.equal((await next).outcome,"accepted");
  const dropped=h.session.sendCommand({msgType:"cancelCall",body:{destination:{name:"Kitchen",type:"table"}}});h.session.close();
  assert.equal((await dropped).outcome,"unknown");assert.throws(()=>h.session.sendCommand({msgType:"call",body:{}}),/not ready/);
});
test("only notifications from the registered robot to this controller become task events",()=>{
  const h=commandHarness();
  const n={msgType:"notifyCustomCall",source:"device",target:h.id,body:{state:"Arrived",destinationName:"Kitchen",taskId:"task-123",operationType:"remote"}};
  h.publish({...n,target:"other"});h.publish({...n,source:"other"});h.publish({...n,body:{...n.body,state:"bad"}});
  assert.equal(h.events.filter(e=>e.event==="robot_task_notification").length,0);
  h.publish(n);assert.equal(h.events.at(-1).notification.taskId,"task-123");
  h.publish({msgType:"notifyGoState",source:"device",target:h.id,body:{robotGoState:"Arrived",destination:{name:"Kitchen",type:"table"}}});
  assert.equal(h.events.at(-1).kind,"call");
});

test("fragmented CONNECT and coalesced packets acknowledge without leaking credentials", () => {
  const h = harness();
  const start = connect();
  for (const byte of start) h.session.push(Buffer.from([byte]));
  h.session.push(Buffer.concat([packet(0xc0), packet(0xc0)]));
  assert.deepEqual(h.writes.map((p) => p.toString("hex")), ["20020000", "d000", "d000"]);
  assert.equal(h.events[0].protocol, "3.1.1");
  assert.equal(h.events[0].willIgnored, true);
  assert.doesNotMatch(JSON.stringify(h.events), /private|password|username|device-id/);
});

test("subscriptions and QoS 0/1/2 publications never forward application messages", () => {
  const h = harness();
  h.session.push(connect());
  h.session.push(packet(0x82, Buffer.concat([Buffer.from([0, 9]), field("/private-product/private-device/user/sub_sdk"), Buffer.from([1])])));
  const body = Buffer.from(JSON.stringify({ msgType: "test_message", body: { password: "private-secret" }, privateKeyName: "hidden" }));
  for (let qos = 0; qos <= 2; qos++) {
    h.session.push(packet(0x30 | (qos << 1), Buffer.concat([
      field("/private-product/private-device/user/pub_sdk"), qos ? Buffer.from([0, 17]) : Buffer.alloc(0), body,
    ])));
  }
  h.session.push(packet(0x62, Buffer.from([0, 17])));
  h.session.push(packet(0xe0));
  assert.deepEqual(h.writes.map((p) => p.toString("hex")), ["20020000", "9003000901", "40020011", "50020011", "70020011"]);
  assert.ok(h.writes.every((p) => (p[0] >> 4) !== 3));
  assert.equal(h.ended(), true);
  assert.doesNotMatch(JSON.stringify(h.events), /private|hidden/);
  assert.equal(h.events.filter((e) => e.event === "received_publication").length, 3);
  assert.deepEqual(h.events[2].payload.knownKeys, ["msgType", "body"]);
  assert.equal(h.events[2].payload.otherKeyCount, 1);
});

test("explicit registration only answers a subscribed shadow GET, with no command or group change", () => {
  const writes = [];
  const events = [];
  const id = "pudu-laptop-1234567812345678";
  const session = createMqttSession({ write: (p) => writes.push(p), event: (e) => events.push(e), controllerId: id });
  session.push(connect());
  const request = packet(0x30, Buffer.concat([field("/shadow/update/product/device"), Buffer.from('{"method":"get"}')]));
  session.push(request);
  assert.equal(writes.length, 1, "No response before matching subscription");
  session.push(packet(0x82, Buffer.concat([Buffer.from([0, 2]), field("/shadow/get/product/device"), Buffer.from([0])])));
  session.push(request);
  assert.equal(writes.length, 3);
  const sent = writes[2];
  assert.equal(sent[0], 0x30);
  let index = 1;
  while (sent[index++] & 128) {}
  const topicLength = sent.readUInt16BE(index); index += 2;
  assert.equal(sent.subarray(index, index + topicLength).toString(), "/shadow/get/product/device");
  const setup = JSON.parse(sent.subarray(index + topicLength));
  assert.deepEqual(setup.payload.state.desired, { authConfig: { sdk: [{ id, listener: [] }] } });
  assert.deepEqual(setup.payload.state.reported, {});
  assert.equal(setup.payload.state.desired.groupId, undefined);
  assert.equal(setup.msgType, undefined);
  session.push(request);
  assert.equal(writes.length, 3, "Registration is only sent once per connection");
  session.push(packet(0x30, Buffer.concat([field("/shadow/update/product/device"), Buffer.from(JSON.stringify({method:"update",state:{reported:{authConfig:{sdk:[{id}]}}}}))])));
  assert.equal(events.at(-1).localControllerPresent, true);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(id));
});

test("unrecognized topics and malformed payloads are omitted without echoing content", () => {
  assert.equal(topicShape("/shadow/get/secret-product/secret-device"), "/shadow/get/{product}/{device}");
  assert.equal(topicShape("/sys/secret-product/secret-device/thing/event/property/post"), "/sys/{product}/{device}/thing/event/property/post");
  assert.equal(topicShape("/unknown/secret"), "[unrecognized topic omitted]");
  assert.deepEqual(payloadShape(Buffer.from("private-non-json")), { bytes: 16, jsonObject: false });
  assert.doesNotMatch(JSON.stringify(payloadShape(Buffer.from('{"privateKey":"secret"}'))), /privateKey|secret/);
});

test("status probe requires registered controller and verifies response identity and fields", () => {
  const writes = [];
  const events = [];
  const id = "pudu-laptop-1234567812345678";
  const maps = [];
  let clock = 1000;
  const session = createMqttSession({write: p => writes.push(p), event: e => events.push(e), controllerId: id, statusProbe: true, mapRead: true, mapReceived: m => maps.push(m), now: () => clock});
  assert.equal(session.refreshReads({map:true}), false, "No reads before a registered connection");
  function publish(topic, body) { session.push(packet(0x30, Buffer.concat([field(topic), Buffer.from(JSON.stringify(body))]))); }
  function parsePublication(p) {
    let i = 1; while (p[i++] & 128) {}
    const size = p.readUInt16BE(i); i += 2;
    return {topic:p.subarray(i,i+size).toString(),data:JSON.parse(p.subarray(i+size))};
  }
  session.push(connect());
  session.push(packet(0x82, Buffer.concat([Buffer.from([0, 1]),
    ...["/shadow/get/product/device", "/product/device/user/sub_service", "/product/device/user/sub_sdk"].flatMap(t => [field(t),Buffer.from([0])])])));
  const online = {msgType:"getDeviceOnlineState",msgId:"req123",source:"device",target:id,body:{}};
  publish("/product/device/user/pub_service", online);
  assert.equal(writes.length,2);
  publish("/shadow/update/product/device",{method:"get"});
  publish("/shadow/update/product/device",{method:"update",state:{reported:{authConfig:{sdk:[{id}]}}}});
  publish("/product/device/user/pub_service", {...online,target:"unrelated-controller"});
  assert.equal(writes.length,3);
  publish("/product/device/user/pub_service", online);
  assert.equal(writes.length,5);
  assert.equal(parsePublication(writes[3]).data.body.state,"ONLINE");
  const request = parsePublication(writes[4]);
  assert.equal(request.data.msgType,"query_state");
  publish("/product/device/user/pub_service", online);
  assert.equal(writes.length,6,"Retry gets presence reply but no repeated state query");
  const body = {robotState:"Free",robotPower:60,moveState:"Idle",chargeStage:"Idle",robotPose:{x:1,y:2,angle:3},password:"private-secret"};
  const response={msgType:"query_state",msgId:request.data.msgId,source:"device",target:id,body};
  publish("/product/device/user/pub_sdk",{...response,msgId:"wrong"});
  assert.equal(events.some(e=>e.event==="robot_status_response_verified"),false);
  publish("/product/device/user/pub_sdk",response);
  const result = events.find(e=>e.event==="robot_status_response_verified");
  assert.equal(result.event,"robot_status_response_verified");
  assert.equal(result.status.robotPower,60);
  assert.deepEqual(result.status.robotPose,{x:1,y:2,angle:3});
  assert.doesNotMatch(JSON.stringify(result),/private|password/);
  assert.equal(result.motionCommandsEnabled,false);
  const destinationsRequest = parsePublication(writes.at(-1)).data;
  assert.equal(destinationsRequest.msgType,"request_data");
  assert.deepEqual(destinationsRequest.body,{pageSize:100,pageIndex:1});
  publish("/product/device/user/pub_sdk",{...response,msgType:"request_data",msgId:destinationsRequest.msgId,
    body:{pageIndex:1,pageSize:100,total:2,destinations:[{name:"Home",type:"dining_outlet",privateField:"secret"},{name:"Start/Return",type:"",privateField:"secret"}]}});
  const points = events.find(e=>e.event==="robot_destinations_response_verified");
  assert.deepEqual(points.destinations,[{name:"Home",type:"dining_outlet"}]);
  assert.equal(points.complete,false);
  assert.deepEqual(points.rejected,[{name:"Start/Return",typeKind:"string",typeLength:0,emptyType:true}]);
  assert.doesNotMatch(JSON.stringify(points), /privateField|secret/);
  assert.equal(session.refreshReads({map:true}), false, "Do not overlap destination/map reads");
  const mapRequest = parsePublication(writes.at(-1)).data;
  assert.equal(mapRequest.msgType,"getRobotCurrentMap");
  const document = {map:{elements:[{type:"source",name:"Home",vector:[1,2,3]}],zones:[]}};
  const encoded = zlib.gzipSync(JSON.stringify(document)).toString("base64");
  publish("/product/device/user/pub_sdk",{...response,msgType:"getRobotCurrentMap",msgId:"wrong",body:{data:encoded}});
  assert.equal(maps.length,0);
  publish("/product/device/user/pub_sdk",{...response,msgType:"getRobotCurrentMap",msgId:mapRequest.msgId,body:{data:encoded}});
  assert.deepEqual(maps,[document]);
  assert.equal(events.at(-1).event,"current_map_response_verified");
  const tooLarge = zlib.gzipSync(Buffer.alloc(8*1024*1024+1)).toString("base64");
  publish("/product/device/user/pub_sdk",{...response,msgType:"getRobotCurrentMap",msgId:mapRequest.msgId,body:{data:tooLarge}});
  assert.equal(events.at(-1).event,"current_map_decode_failed");
  assert.equal(maps.length,1);
  clock += 3000;
  assert.equal(session.refreshReads(), true);
  const next = parsePublication(writes.at(-1)).data;
  assert.equal(next.msgType, "query_state");
  assert.notEqual(next.msgId, request.data.msgId);
  const before = events.filter(e => e.event === "robot_status_response_verified").length;
  publish("/product/device/user/pub_sdk", response);
  assert.equal(events.filter(e => e.event === "robot_status_response_verified").length, before, "Ignore late prior-cycle replies");
  publish("/product/device/user/pub_sdk", {...response,msgId:next.msgId});
  assert.equal(events.filter(e => e.event === "robot_status_response_verified").length, before + 1);
  assert.equal(parsePublication(writes.at(-1)).data.msgType, "query_state", "Status-only poll does not request map");
  assert.equal(session.refreshReads(), false, "Reads are rate limited");
  clock += 3000;
  assert.equal(session.refreshReads({map:true}), true);
  const mapStatus = parsePublication(writes.at(-1)).data;
  publish("/product/device/user/pub_sdk", {...response,msgId:mapStatus.msgId});
  assert.equal(parsePublication(writes.at(-1)).data.msgType, "request_data");
  clock += 13000;
  assert.equal(session.refreshReads(), true, "A timed-out read does not block future reads forever");
  const types = writes.filter(p => p[0] === 0x30).map(p => parsePublication(p).data.msgType).filter(Boolean);
  assert.ok(types.every(t => ["getDeviceOnlineState", "query_state", "request_data", "getRobotCurrentMap"].includes(t)));
});

test("reject oversized and malformed frames, wrong protocol, and commands before CONNECT", () => {
  for (const bytes of [Buffer.from([0x30, 255, 255, 255, 255]), Buffer.from([0x30, 128, 0]), Buffer.alloc(MAX_PACKET + 6), packet(0xc0)]) {
    assert.throws(() => harness().session.push(bytes), /MQTT/);
  }
  const badVersion = packet(0x10, Buffer.concat([field("MQTT"), Buffer.from([5, 2, 0, 30]), field("client")]));
  assert.throws(() => harness().session.push(badVersion), /3.1.1/);
  for (const bytes of [packet(0x80, Buffer.from([0, 1])), packet(0x82, Buffer.from([0, 1])),
    packet(0x36, field("topic")), packet(0x32, Buffer.concat([field("topic"), Buffer.from([0, 0])])),
    packet(0x32, Buffer.concat([field("bad/#"), Buffer.from([0, 1])]))]) {
    const h = harness(); h.session.push(connect());
    assert.throws(() => h.session.push(bytes), /MQTT/);
    assert.equal(h.writes.length, 1);
  }
});

test("periodic status polling before the first presence reply still fetches the initial map", () => {
  const writes = [], events = [];
  const id = "pudu-laptop-1234567812345678";
  const session = createMqttSession({write:p=>writes.push(p),event:e=>events.push(e),controllerId:id,statusProbe:true,mapRead:true});
  const publish=(topic,data)=>session.push(packet(0x30,Buffer.concat([field(topic),Buffer.from(JSON.stringify(data))])));
  const parse=p=>{ let i=1; while(p[i++]&128){} const n=p.readUInt16BE(i); i+=2; return JSON.parse(p.subarray(i+n)); };
  session.push(connect());
  session.push(packet(0x82,Buffer.concat([Buffer.from([0,1]),...["/shadow/get/product/device","/product/device/user/sub_service","/product/device/user/sub_sdk"].flatMap(topic=>[field(topic),Buffer.from([0])])])));
  publish("/shadow/update/product/device",{method:"get"});
  publish("/shadow/update/product/device",{method:"update",state:{reported:{authConfig:{sdk:[{id}]}}}});
  assert.equal(session.refreshReads({map:false}),true);
  const request=parse(writes.at(-1));
  assert.equal(events.at(-1).includeMap,true);
  publish("/product/device/user/pub_sdk",{msgType:"query_state",msgId:request.msgId,source:"device",target:id,body:{robotState:"Free",robotPower:39}});
  assert.equal(parse(writes.at(-1)).msgType,"request_data");
});
