const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("main.js", "utf8");
const sandbox = {Hooks: {once() {}}, console};
vm.runInNewContext(source + `
globalThis.auditTest = {
  isConsumption: pcgaIsConsumptionDeletion,
  mark: pcgaMarkConsumedItem,
  forget: pcgaForgetConsumedItem,
  ids: pcgaConsumptionDeletedIds
};`, sandbox, {filename: "main.js"});
const api = sandbox.auditTest;

const actor = {uuid: "Actor.player"};
const otherActor = {uuid: "Actor.other"};
const food = {id: "last-food", parent: actor};
const ammo = {id: "last-arrow", parent: actor};
const otherFood = {id: "last-food", parent: otherActor};
const manual = {id: "manual", parent: actor};

assert.equal(api.isConsumption(food, {lipatosItemConsumed: true}), true,
  "Instant Consumables must not log consumed final food as deletion");
assert.equal(api.isConsumption(ammo, {itemMoveStackUse: true}), true,
  "legacy consumption flag remains compatible");
assert.equal(api.isConsumption(manual, {}), false,
  "manual inventory delete remains audited");
assert.equal(api.isConsumption(food, {lipatosCurrencyTransfer: true}), false,
  "currency suppression still uses its independent flag");

api.mark(actor, "last-arrow");
assert.equal(api.isConsumption(food, {}), false,
  "using ammunition must not suppress deleting a different item");
assert.equal(api.isConsumption(ammo, {}), true,
  "the exact piece of spent ammunition is suppressed");
assert.equal(api.isConsumption(ammo, {}), false,
  "a consumption marker must be single use");

api.mark(actor, "last-food");
assert.equal(api.isConsumption(otherFood, {}), false,
  "another actor's item cannot reuse the first actor's marker");
api.forget(actor, "last-food");
assert.equal(api.isConsumption(food, {}), false,
  "a canceled consumption clears the marker");

assert.deepEqual(Array.from(api.ids({delete: ["id1", {_id: "id2"}, {id: "id3"}]})),
  ["id1", "id2", "id3"], "bulk consumption deletion IDs are recognized");
assert.match(source, /Hooks.on\("dnd5e.activityConsumption"/,
  "native activity consumption is tracked");
assert.match(source, /Hooks.on\("dnd5e.rollAttack"/,
  "ammunition destroyed on an attack is tracked");
assert.match(source, /if \(pcgaIsConsumptionDeletion\(item, options\)\) return;/,
  "deletion audit checks consumption before making a pending deletion entry");
assert.match(source, /if \(options\?\.lipatosCurrencyTransfer\) return;/,
  "currency-to-wallet behavior is preserved");
console.log("LipatoS consumed item, ammunition and manual deletion audit tests passed.");
