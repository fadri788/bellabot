"use strict";
const CAPABILITIES = Object.freeze([
  { id: "status", motion: false, status: "untested", label: "Read status and battery", unlock: "Verify fresh readings on this robot and laptop." },
  { id: "destinations", motion: false, status: "untested", label: "Read named destinations", unlock: "Compare the received destinations with the robot's current map." },
  { id: "goto", motion: true, status: "untested", label: "Supervised trip to a named destination", unlock: "Test one nearby named destination with an operator beside the robot." },
  { id: "cancel", motion: true, status: "untested", label: "Request trip cancellation; verify the physical result", unlock: "Request cancellation on a supervised trip and observe the actual robot." },
]);
module.exports = { CAPABILITIES };
