"use strict";
const net = require("node:net");

function localIPv4(host) {
  if (!net.isIPv4(host)) return false;
  const [a, b] = host.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function normaliseMac(value) {
  const mac = String(value || "").toLowerCase().replace(/:/g, "-");
  return /^(?:[0-9a-f]{2}-){5}[0-9a-f]{2}$/.test(mac) ? mac : null;
}

function matchingNeighbour(text, { laptopIp, robotIp, robotMac }, interfaceName) {
  const wanted = normaliseMac(robotMac);
  if (!wanted) return false;
  let selectedInterface = null;
  for (const line of String(text).split(/\r?\n/)) {
    const header = /^\s*Interface:\s+(\d{1,3}(?:\.\d{1,3}){3})\s+---/i.exec(line);
    if (header) { selectedInterface = header[1]; continue; }
    const parts = line.trim().split(/\s+/);
    if (selectedInterface === laptopIp && parts[0] === robotIp && normaliseMac(parts[1]) === wanted) return true;
    const unix = /\(([^)]+)\)\s+at\s+([0-9a-f:]+).*\bon\s+(\S+)/i.exec(line);
    if (interfaceName && unix && unix[1] === robotIp && unix[3] === interfaceName) {
      const expanded = unix[2].split(":").map(part => part.padStart(2, "0")).join(":");
      if (normaliseMac(expanded) === wanted) return true;
    }
  }
  return false;
}

module.exports = { localIPv4, normaliseMac, matchingNeighbour };
