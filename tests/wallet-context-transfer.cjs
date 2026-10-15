const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const code = fs.readFileSync("main.js", "utf8");
const css = fs.readFileSync("style.css", "utf8");
const users = [
  {id: "gm", isGM: true, active: true},
  {id: "sender", isGM: false, active: true},
  {id: "receiver", isGM: false, active: true}
];
users.get = id => users.find(u => u.id === id);

const origin = {
  id: "src", uuid: "Actor.src", documentName: "Actor", type: "character",
  name: "Отправитель", isOwner: true,
  system: {currency: {cp: 20, sp: 12, gp: 8}},
  testUserPermission: () => true,
  async update(changes) {
    for (const [key, value] of Object.entries(changes))
      this.system.currency[key.split(".").at(-1)] = value;
  }
};
const destination = {
  id: "dst", uuid: "Actor.dst", documentName: "Actor", type: "character",
  name: "Получатель", isOwner: false,
  system: {currency: {cp: 1, sp: 0, gp: 0}},
  async update(changes) {
    for (const [key, value] of Object.entries(changes))
      this.system.currency[key.split(".").at(-1)] = value;
  }
};
users[1].character = origin;
users[2].character = destination;
const actors = [origin, destination];
actors.get = id => actors.find(a => a.id === id);
const handlers = new Map();
const emissions = [];
const socket = {
  on(channel, fn) {handlers.set(channel, [...(handlers.get(channel) ?? []), fn]);},
  off(channel, fn) {handlers.set(channel, (handlers.get(channel) ?? []).filter(f => f !== fn));},
  emit(channel, payload) {
    emissions.push(payload.type);
    for (const fn of (handlers.get(channel) ?? []).slice()) fn(payload);
  }
};
const hooks = {once() {}};
const tool = {utils: {randomID: () => "r1"}};
function api(currentUser) {
  const sandbox = {
    game: {user: currentUser, users, actors, socket, i18n: {lang: "ru"}},
    Hooks: hooks, foundry: tool, console,
    fromUuid: async uuid => uuid === origin.uuid ? origin : null,
    setTimeout: () => 123, clearTimeout: () => {}
  };
  vm.runInNewContext(code + `
globalThis.test = {
  request: pcgaRequestCurrencyTransfer,
  remote: pcgaGMRemoteCurrency,
  selectCoin: pcgaWalletCoinFromLabel,
  validate: pcgaValidateWalletAmounts
};`, sandbox);
  return sandbox.test;
}

function walletLabel(code, {hasWallet = true, iconType = "img"} = {}) {
  const inventory = {document: origin};
  const section = {closest: selector => selector === "dnd5e-inventory" && hasWallet ? inventory : null};
  const input = {name: "system.currency." + code};
  const icon = {tagName: iconType.toUpperCase(), dataset: {actorUuid: origin.uuid}};
  const label = {
    closest: selector => selector === "section.currency" && hasWallet ? section : null,
    querySelector(selector) {
      if (selector === 'input[name^="system.currency."]') return input;
      if (selector.includes("img.currency") && iconType === "img") return icon;
      return null;
    }
  };
  return {label, icon, input};
}

(async () => {
  const gm = api(users[0]);
  const player = api(users[1]);
  for (const code of ["cp", "sp", "gp"]) {
    const coin = walletLabel(code, {iconType: "img"});
    assert.equal(gm.selectCoin(coin.label).code, code,
      "recognize the coin when the original <i> was replaced by a draggable <img>: " + code);
    assert.equal(gm.selectCoin(walletLabel(code, {iconType: "i"}).label).code, code,
      "also recognize the original D&D5e icon: " + code);
    assert.equal(gm.selectCoin(walletLabel(code, {hasWallet: false}).label), null,
      "do not interpret a price icon as money in the character wallet: " + code);
  }
  assert.match(code, /event\.target\?\.closest\?\.\("label"\)/,
    "contextmenu must recognize the input, coin image and label without rigid direct-child CSS");
  assert.equal(gm.validate({sp: 5}).sp, 5);
  assert.equal(gm.validate({gp: 1.5}), null, "fractional coin transfers must be rejected");
  assert.equal(gm.validate({pp: 10}), null, "nonexistent currency must be rejected");

  const direct = await gm.request(origin, {id: destination.id}, {gp: 2});
  assert.equal(direct.ok, true, "GM transfer executes without waiting for socket");
  assert.deepEqual(emissions, [], "GM must not send requests to itself");
  assert.equal(origin.system.currency.gp, 6);
  assert.equal(destination.system.currency.gp, 2);

  socket.on("module.lipatos-player-currency-gm-audit", packet => {
    if (packet.type === "remote-currency-request") void gm.remote(packet);
  });
  const delegated = await player.request(origin, {id: destination.id}, {sp: 4});
  assert.equal(delegated.ok, true, "different-owned wallets use automatic GM execution");
  assert.deepEqual(emissions, ["remote-currency-request", "remote-currency-result"]);
  assert.equal(origin.system.currency.sp, 8);
  assert.equal(destination.system.currency.sp, 4);

  const invalid = await gm.request(origin, {id: destination.id}, {cp: 50});
  assert.equal(invalid.ok, false);
  assert.equal(origin.system.currency.cp, 20);
  assert.equal(destination.system.currency.cp, 1);

  assert.match(css, /dnd5e-inventory > section\.currency > button\[data-action="currency"\]/,
    "the old currency-management button must be hidden");
  assert.match(code, /Передать предмет/,
    "right-click must show the same item-transfer command");
  assert.match(code, /pcgaInstallWalletContextMenu\(\)/,
    "wallet context menu must be installed on ready");
  console.log("Wallet context menu, transfer, overspend and hide-icon tests passed.");
})().catch(err => {console.error(err); process.exitCode = 1;});
