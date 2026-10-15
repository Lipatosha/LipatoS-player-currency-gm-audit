const assert = require("node:assert/strict");
const fs = require("node:fs");
const file = fs.readFileSync("main.js", "utf8");

for (const hook of ["createItem", "preUpdateItem", "updateItem", "deleteItem"]) {
  const start = file.indexOf(`Hooks.on("${hook}"`);
  assert.ok(start !== -1, `missing ${hook} audit hook`);
  const next = file.indexOf('Hooks.on("', start + 10);
  const body = file.slice(start, next === -1 ? file.length : next);
  assert.ok(body.includes("options?.lipatosItemTransfer"),
    `${hook} must ignore item move operations already reported through unified transfer event`);
}

assert.ok(file.includes('Hooks.on("lipatosItemTransferCompleted"'),
  "successful transfers are still logged through the centralized hook");
assert.ok(file.includes('if (pcgaIsConsumptionDeletion(item, options)) return;'),
  "consumption remains excluded from manual deletion notifications");
assert.ok(file.includes('if (options?.lipatosCurrencyTransfer) return;'),
  "physical coin conversion remains excluded from deletion notifications");
console.log("Direct item transfer audit deduplication checks passed.");
