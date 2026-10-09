const test = require("node:test");
const assert = require("node:assert/strict");
const { localIPv4, matchingNeighbour } = require("../src/network");

const config = { laptopIp: "192.168.50.10", robotIp: "192.168.50.20", robotMac: "02:00:00:00:00:01" };
test("robot identity must match both its address and the chosen laptop interface", () => {
  const table = "Interface: 192.168.50.10 --- 0x4\n  192.168.50.20  02-00-00-00-00-01  dynamic\n";
  assert.equal(matchingNeighbour(table, config), true);
  assert.equal(matchingNeighbour(table, { ...config, laptopIp: "192.168.50.11" }), false);
  assert.equal(matchingNeighbour(table, { ...config, robotIp: "192.168.50.21" }), false);
  assert.equal(matchingNeighbour(table, { ...config, robotMac: "02:00:00:00:00:02" }), false);
});
test("Unix neighbour parsing requires the selected interface", () => {
  const table = "? (192.168.50.20) at 2:0:0:0:0:1 on en0 ifscope [ethernet]";
  assert.equal(matchingNeighbour(table, config, "en0"), true);
  assert.equal(matchingNeighbour(table, config, "en1"), false);
});
test("the transport accepts only private IPv4 or loopback addresses", () => {
  for (const address of ["10.0.0.2", "172.16.0.2", "192.168.1.2", "127.0.0.1"]) assert.equal(localIPv4(address), true);
  for (const address of ["8.8.8.8", "172.15.0.1", "localhost", "::1", "10.0.0.999"]) assert.equal(localIPv4(address), false);
});
