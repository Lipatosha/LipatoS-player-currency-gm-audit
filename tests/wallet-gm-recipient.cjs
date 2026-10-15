const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const script = fs.readFileSync("main.js", "utf8");
const style = fs.readFileSync("style.css", "utf8");

const gm = {id: "gm", name: "ГМ", isGM: true, active: true};
const users = [gm];
users.get = id => users.find(user => user.id === id);

const character = {
  id: "character1", uuid: "Actor.character1", documentName: "Actor",
  type: "character", name: "Габриэль (копия)", isOwner: true,
  system: {currency: {gp: 5, sp: 38, cp: 8}},
  testUserPermission: () => true,
  async update(data) {
    for (const [path, amount] of Object.entries(data)) {
      if (!path.startsWith("system.currency.")) throw Error("Unexpected update: " + path);
      this.system.currency[path.slice("system.currency.".length)] = amount;
    }
  }
};

const actors = [character];
actors.get = id => actors.find(actor => actor.id === id);
const messages = [];
let dialogConfig;
let contextHandler;
let visibleMenu;
const foundry = {
  utils: {
    randomID: () => "wallet-dialog-test",
    escapeHTML: text => String(text)
  },
  applications: {
    api: {
      DialogV2: {
        async wait(config) {
          dialogConfig = config;
          return {index: 0, amount: 3};
        }
      }
    }
  }
};
const listeners = new Map();
const fakeDocument = {
  addEventListener(event, fn) {
    listeners.set(event, fn);
    if (event === "contextmenu") contextHandler = fn;
  },
  removeEventListener(event) {listeners.delete(event);},
  createElement(tag) {
    return {
      tagName: tag.toUpperCase(), className: "", style: {},
      children: [], offsetWidth: 180, offsetHeight: 38,
      addEventListener(name, fn) {this[name] = fn;},
      setAttribute(name, value) {(this.attributes ??= {})[name] = value;},
      appendChild(node) {this.children.push(node);},
      focus() {},
      remove() {this.removed = true;},
      contains(node) {return this === node || this.children.includes(node);}
    };
  },
  body: {appendChild(node) {visibleMenu = node;}}
};

const sandbox = {
  game: {user: gm, users, actors, i18n: {lang: "ru"}},
  foundry, document: fakeDocument, window: {innerWidth: 1100, innerHeight: 750},
  Hooks: {once() {}},
  ui: {notifications: {warn(text) {messages.push(text);}, info(text) {messages.push(text);}}},
  console
};
vm.runInNewContext(script + `
globalThis.api = {
  recipients: pcgaTransferRecipients,
  dialog: pcgaOpenWalletTransferDialog,
  install: pcgaInstallWalletContextMenu
};`, sandbox, {filename: "main.js"});

(async () => {
  const recipients = Array.from(sandbox.api.recipients(character), x => x.id);
  assert.deepEqual(recipients, ["__GM__"],
    "GM must remain selectable even when the GM is the only connected user");

  await sandbox.api.dialog(character, "sp");
  assert.match(dialogConfig.content, /<option value="0">ГМ<\/option>/,
    "the wallet transfer dialogue must show GM in the actual selector");
  assert.equal(character.system.currency.sp, 35,
    "GM-to-GM treasury transfer deducts the chosen amount immediately");
  assert.ok(messages.includes("Монеты переданы."));

  sandbox.api.install();
  assert.equal(typeof contextHandler, "function");

  const label = {
    querySelector(selector) {
      return selector === 'input[name^="system.currency."]'
        ? {name: "system.currency.gp"} : null;
    },
    closest(selector) {
      if (selector === "section.currency") return {
        closest(inner) {return inner === "dnd5e-inventory" ? {document: character} : null;}
      };
      return null;
    }
  };
  const event = {
    target: {closest: selector => selector === "label" ? label : null},
    clientX: 80, clientY: 80,
    preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}
  };
  contextHandler(event);
  const menuItem = visibleMenu?.children?.[0];
  assert.equal(menuItem?.tagName, "DIV",
    "the wallet context entry must not be a light-themed HTML button");
  assert.equal(menuItem?.attributes?.role, "menuitem");
  assert.match(menuItem?.innerHTML ?? "", /Передать предмет/);
  assert.match(style, /\.pcga-wallet-context-menu \.pcga-wallet-context-item\s*\{/,
    "the dark menu entry must have explicit Foundry-compatible styles");
  assert.match(style, /background: #292429;/,
    "menu entry must not inherit the white form button background");

  console.log("GM-only recipient, wallet deduction, and dark RMB menu tests passed.");
})().catch(err => {console.error(err); process.exitCode = 1;});
