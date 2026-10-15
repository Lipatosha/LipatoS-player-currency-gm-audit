const assert = require("node:assert/strict");
const fs = require("node:fs");
const script = fs.readFileSync("main.js", "utf8");
const handler = script.indexOf('Hooks.on("deleteItem"');
const flag = script.indexOf('if (options?.lipatosCurrencyTransfer) return;', handler);
const pairing = script.indexOf('const paired = takeMatchingDestination(item);', handler);
const messages = script.indexOf('await playerItemConfirmation(payload);', handler);
assert.ok(handler >= 0, "the item deletion audit must exist");
assert.ok(flag > handler && flag < pairing,
  "coin wallet transfers must be excluded before deletion auditing and pairing");
assert.ok(messages > pairing, "ordinary item deletion reports must remain intact");
assert.ok(script.includes('if (options?.itemMoveStackMerge) return;'),
  "existing technical-delete exceptions must remain intact");
console.log("LipatoS item audit wallet transfer tests passed.");
