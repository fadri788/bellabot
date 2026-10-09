"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { publicAtlas, createMonitor, createMonitorServer } = require("../src/local-monitor");

test("map projection exposes only bounded geometry and names", () => {
  const result = publicAtlas({password:"private",map:{elements:[
    {type:"source",name:"Home",mode:"parking",vector:[1,2,0],privateField:"secret"},
    {type:"track",vector:[1,2,3,4],token:"secret"},
    {type:"source",name:"Bad",vector:[NaN,2,0]}, {type:"camera",url:"private"},
  ]}});
  assert.equal(result.elements.length,2);
  assert.match(result.id,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result),/password|private|secret|token/);
  assert.throws(()=>publicAtlas({map:{elements:Array(20001).fill({})}}),/Unrecognized/);
});

test("connected socket alone never means fresh data and reconnect invalidates freshness", () => {
  let clock = 100000;
  const monitor = createMonitor({host:"192.0.2.12",robot:"192.0.2.20",now:()=>clock});
  monitor.event({event:"mqtt_connected"});
  assert.equal(monitor.snapshot().fresh,false);
  monitor.event({event:"controller_configuration_reported",localControllerPresent:true});
  monitor.event({event:"robot_status_response_verified",status:{robotPower:42,robotState:"Busy"}});
  assert.equal(monitor.snapshot().fresh,true);
  clock -= 1;
  assert.equal(monitor.snapshot().fresh,false,"clock rollback cannot make future data fresh");
  clock += 1;
  clock += 18001;
  assert.equal(monitor.snapshot().fresh,false);
  monitor.event({event:"robot_status_response_verified",status:{robotPower:41,robotState:"Busy"}});
  monitor.event({event:"connection_closed"});
  assert.equal(monitor.snapshot().connected,false);
  assert.equal(monitor.snapshot().status.robotPower,41,"Retain timestamped last reading");
  monitor.event({event:"mqtt_connected"});
  assert.equal(monitor.snapshot().fresh,false);
  assert.equal(monitor.snapshot().mapPending,true);
});

test("loopback monitor exposes fixed reads only; rejects cross-origin and extra command fields", async t => {
  const requests=[];
  const bridge=createMonitorServer({monitor:createMonitor({}),refresh:args=>{requests.push(args);return true;},port:0});
  const address=await bridge.listen(); t.after(()=>bridge.close());
  const url=`http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${url}/state`)).status,200);
  const post=body=>fetch(`${url}/refresh`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await post({scope:"map"})).status,202);
  assert.deepEqual(requests,[{map:true}]);
  assert.equal((await post({scope:"map",command:"call"})).status,400);
  assert.equal((await post({scope:"call"})).status,400);
  assert.equal((await fetch(`${url}/call`,{method:"POST"})).status,404);
  assert.equal((await fetch(`${url}/state`,{headers:{Origin:"https://external.example"}})).status,403);
  const badHostStatus = await new Promise((resolve,reject) => {
    const request = require("node:http").get(`${url}/state`,{headers:{Host:"attacker.example"}},response => { response.resume(); resolve(response.statusCode); });
    request.on("error",reject);
  });
  assert.equal(badHostStatus,403);
  assert.equal(requests.length,1);
});

test("every capability that is not verified says what would unlock it", () => {
  const { CAPABILITIES } = require("../src/capabilities");
  for (const c of CAPABILITIES) {
    if (c.status === "verified") {
      assert.equal(c.unlock, undefined, `${c.id} is verified, so it needs no unlock line`);
    } else {
      assert.equal(typeof c.unlock, "string", `${c.id} has no unlock line`);
      assert.ok(c.unlock.length > 20 && c.unlock.length < 160, `${c.id} unlock line is the wrong length`);
    }
    assert.ok(["verified", "untested", "unavailable"].includes(c.status), `${c.id} has an unknown status`);
  }
});

test("monitor shutdown closes an incomplete command request without executing it", { timeout: 3000 }, async t => {
  let commands = 0;
  const bridge = createMonitorServer({
    monitor: createMonitor({}), refresh: () => false, port: 0,
    control: { execute() { commands += 1; } },
  });
  const address = await bridge.listen();
  const socket = net.createConnection({ host: "127.0.0.1", port: address.port });
  t.after(async () => { socket.destroy(); await bridge.close(); });
  await once(socket, "connect");
  const received = once(bridge.server, "request");
  socket.write(`POST /api/local/control HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await received;
  const disconnected = once(socket, "close");
  let timer;
  try {
    await Promise.race([
      bridge.close(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Incomplete request held the monitor open.")), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
  await disconnected;
  assert.equal(bridge.server.listening, false);
  assert.equal(commands, 0);
});
