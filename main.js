const MODULE_ID = "lipatos-player-currency-gm-audit";
const LEGACY_SOCKET = "module.player-currency-gm-audit";
const SOCKET = `module.${MODULE_ID}`;

const LABELS = {
  pp: "платины",
  gp: "золота",
  ep: "электрума",
  sp: "серебра",
  cp: "меди"
};

function gmIds() {
  return game.users.filter(u => u.isGM).map(u => u.id);
}

function primaryActiveGM() {
  return game.users
    .filter(u => u.isGM && u.active)
    .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

function normalizeAmounts(amounts = {}) {
  const out = {};
  for (const key of Object.keys(CONFIG.DND5E.currencies ?? {})) {
    const value = Math.max(0, Number(amounts[key] ?? 0) || 0);
    if (value > 0) out[key] = value;
  }
  return out;
}

function formatAmounts(amounts = {}) {
  const entries = Object.entries(normalizeAmounts(amounts));
  if (!entries.length) return "0";
  return entries
    .map(([key, value]) => `<strong>${value}</strong> ${LABELS[key] ?? key}`)
    .join(", ");
}

function docName(doc) {
  if (!doc) return "неизвестно";
  if (doc.documentName === "Item" && doc.parent) return `${doc.parent.name} → ${doc.name}`;
  return doc.name ?? "неизвестно";
}

function destinationName(destinations, {toGM = false} = {}) {
  if (toGM) return "ГМ";

  const names = (destinations ?? [])
    .map(d => docName(d))
    .filter(Boolean);

  return names.length ? names.join(", ") : "неизвестный получатель";
}

async function playerConfirmation(destinations, amounts, {toGM = false} = {}) {
  if (game.user.isGM) return;

  const destination = foundry.utils.escapeHTML(destinationName(destinations, {toGM}));
  const money = formatAmounts(amounts);

  const content = `
    <div class="pcga-player-confirm">
      <div>🪙 <strong>Передача денег</strong></div>
      <div>Вы передали <strong>→ [ ${destination} ]</strong></div>
      <div>Монеты: ${money}</div>
      <div><strong>Успешно передано ✓</strong></div>
    </div>`;

  await ChatMessage.create({
    content,
    whisper: [game.user.id],
    speaker: ChatMessage.getSpeaker()
  });
}

async function createGMAuditMessage(payload) {
  if (!game.user.isGM) return;

  const primaryGM = primaryActiveGM();
  if (primaryGM && primaryGM.id !== game.user.id) return;

  const {
    actorUuid,
    actorName,
    destinationNames = [],
    amounts = {},
    toGM = false
  } = payload ?? {};

  let actor = null;
  if (actorUuid) {
    try {
      actor = await fromUuid(actorUuid);
      if (actor?.documentName === "Item") actor = actor.parent;
    } catch (_) {}
  }

  const who = foundry.utils.escapeHTML(actor?.name ?? actorName ?? "Игрок");
  const money = formatAmounts(amounts);

  let destinationText;
  if (toGM) {
    destinationText = "<strong>ГМу</strong>";
  } else {
    const safeNames = destinationNames.map(n => `<strong>${foundry.utils.escapeHTML(n)}</strong>`);
    destinationText = safeNames.length ? safeNames.join(", ") : "<strong>неизвестному получателю</strong>";
  }

  // IMPORTANT:
  // This message is created by the GM client itself and whispered only to that GM.
  // Do not use blind mode: in Foundry that can render the GM's own message as hidden/???.
  const cleanDestination = destinationText.replace(/<\?strong>/g, "");
  const cleanMoney = money.replace(/<\?strong>/g, "");

  const content = `
    <div class="pcga-chat-log">
      🪙 <strong>Передача денег</strong><br>
      ${who} <strong>→ [ ${cleanDestination} ]</strong><br>
      Монеты: <strong>${cleanMoney}</strong><br>
      <strong>Передача выполнена ✓</strong>
    </div>`;

  await ChatMessage.create({
    content,
    whisper: [game.user.id],
    speaker: actor?.documentName === "Actor"
      ? ChatMessage.getSpeaker({actor})
      : ChatMessage.getSpeaker()
  });
}

function sendAuditToGM(origin, destinations, amounts, {toGM = false} = {}) {
  if (game.user.isGM) return;

  const actor = origin?.documentName === "Actor" ? origin : origin?.parent;
  const destinationNames = (destinations ?? []).map(d => docName(d));

  game.socket.emit(SOCKET, {
    type: "audit",
    actorUuid: actor?.uuid ?? null,
    actorName: actor?.name ?? game.user.name,
    destinationNames,
    amounts: normalizeAmounts(amounts),
    toGM
  });
}

function readAmounts(app) {
  const amounts = {};
  for (const key of Object.keys(CONFIG.DND5E.currencies ?? {})) {
    const input = app.element?.querySelector?.(`[name="amount.${key}"]`);
    amounts[key] = Math.max(0, Number(input?.value ?? 0) || 0);
  }
  return normalizeAmounts(amounts);
}

function currencyOwnerDocument(app) {
  return app.document ?? app.options?.document ?? null;
}

async function sendToGM(app) {
  if (game.user.isGM) return;

  const doc = currencyOwnerDocument(app);
  if (!doc?.system?.currency) {
    ui.notifications.warn("Не удалось определить кошелёк.");
    return;
  }

  const amounts = readAmounts(app);
  if (!Object.keys(amounts).length) {
    ui.notifications.warn("Укажи количество денег для передачи ГМу.");
    return;
  }

  for (const [key, amount] of Object.entries(amounts)) {
    const current = Number(doc.system.currency[key] ?? 0) || 0;
    if (amount > current) {
      ui.notifications.warn(`Недостаточно валюты: ${key.toUpperCase()}.`);
      return;
    }
  }

  const updates = {};
  for (const [key, amount] of Object.entries(amounts)) {
    const current = Number(doc.system.currency[key] ?? 0) || 0;
    updates[`system.currency.${key}`] = current - amount;
  }

  try {
    await doc.update(updates, {[MODULE_ID]: {toGM: true}});

    sendAuditToGM(doc, [], amounts, {toGM: true});
    await playerConfirmation([], amounts, {toGM: true});

    ui.notifications.info("Деньги переданы ГМу.");
    app.close();
  } catch (err) {
    console.error(`${MODULE_ID} | Send to GM failed`, err);
    ui.notifications.error("Не удалось передать деньги ГМу. Смотри консоль F12.");
  }
}


function pcgaTransferRecipients(originActor) {
  const result = [{id: "__GM__", name: "ГМ", type: "gm"}];

  // Группа теперь находится внутри "Выбор игрока".
  for (const actor of game.actors) {
    if (actor.id === originActor?.id) continue;
    if (actor.type !== "group") continue;

    result.push({
      id: actor.id,
      name: actor.name,
      type: "group"
    });
  }

  // Затем остальные персонажи.
  for (const actor of game.actors) {
    if (actor.id === originActor?.id) continue;
    if (actor.type !== "character") continue;

    result.push({
      id: actor.id,
      name: actor.name,
      type: "character"
    });
  }

  return result;
}

async function pcgaGMRemoteCurrency(payload) {
  if (!game.user.isGM) return;

  const primary = primaryActiveGM();
  if (primary && primary.id !== game.user.id) return;

  const origin = await fromUuid(payload?.originActorUuid).catch(() => null);

  if (!origin?.system?.currency) {
    game.socket.emit(SOCKET, {
      type: "remote-currency-result",
      requestId: payload.requestId,
      ok: false,
      error: "Отправитель больше недоступен."
    });
    return;
  }

  const amounts = normalizeAmounts(payload?.amounts ?? {});
  const originUpdate = {};
  const targetUpdate = {};

  // Special destination: GM. Money is removed from the sender,
  // and the normal GM audit records the operation.
  if (payload?.targetActorId === "__GM__") {
    for (const [key, amount] of Object.entries(amounts)) {
      const from = Number(origin.system.currency[key] ?? 0) || 0;
      if (amount > from) {
        game.socket.emit(SOCKET, {
          type: "remote-currency-result",
          requestId: payload.requestId,
          ok: false,
          error: `Недостаточно валюты: ${key.toUpperCase()}`
        });
        return;
      }
      originUpdate[`system.currency.${key}`] = from - amount;
    }

    await origin.update(originUpdate);

    game.socket.emit(SOCKET, {
      type: "remote-currency-result",
      requestId: payload.requestId,
      ok: true,
      targetActorId: "__GM__",
      targetName: "ГМ"
    });
    return;
  }

  const target = game.actors.get(payload?.targetActorId);

  if (!target?.system?.currency) {
    game.socket.emit(SOCKET, {
      type: "remote-currency-result",
      requestId: payload.requestId,
      ok: false,
      error: "Получатель больше недоступен."
    });
    return;
  }

  for (const [key, amount] of Object.entries(amounts)) {
    const from = Number(origin.system.currency[key] ?? 0) || 0;
    if (amount > from) {
      game.socket.emit(SOCKET, {
        type: "remote-currency-result",
        requestId: payload.requestId,
        ok: false,
        error: `Недостаточно валюты: ${key.toUpperCase()}`
      });
      return;
    }

    const to = Number(target.system.currency[key] ?? 0) || 0;
    originUpdate[`system.currency.${key}`] = from - amount;
    targetUpdate[`system.currency.${key}`] = to + amount;
  }

  await origin.update(originUpdate);
  await target.update(targetUpdate);

  game.socket.emit(SOCKET, {
    type: "remote-currency-result",
    requestId: payload.requestId,
    ok: true,
    targetActorId: target.id,
    targetName: target.name
  });
}

async function pcgaOpenPlayerTransferDialog(app) {
  const origin = currencyOwnerDocument(app);
  const recipients = pcgaTransferRecipients(origin);

  if (!recipients.length) {
    ui.notifications.warn("Нет доступных получателей.");
    return;
  }

  const amounts = readAmounts(app);
  if (!Object.keys(amounts).length) {
    ui.notifications.warn("Сначала укажи сумму для передачи.");
    return;
  }

  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return;

  const options = recipients
    .map((recipient, index) => `<option value="${index}">${foundry.utils.escapeHTML(recipient.name)}</option>`)
    .join("");

  const selectedIndex = await DialogV2.wait({
    window: {title: "Выбор игрока"},
    modal: true,
    content: `
      <div class="standard-form pcga-recipient-dialog">
        <div class="form-group">
          <label>Получатель</label>
          <div class="form-fields">
            <select name="recipient">${options}</select>
          </div>
        </div>
      </div>`,
    buttons: [
      {
        action: "confirm",
        label: "Подтвердить",
        default: true,
        callback: (event, button) => Number(button.form?.elements?.recipient?.value ?? -1)
      },
      {
        action: "cancel",
        label: "Отмена",
        callback: () => null
      }
    ],
    close: () => null
  });

  if (selectedIndex == null) return;

  const selected = recipients[selectedIndex];
  if (!selected) {
    ui.notifications.warn("Получатель больше недоступен.");
    return;
  }

  await pcgaRemoteCurrencyTransfer(origin, selected, amounts);

  if (selected.id === "__GM__") {
    await playerConfirmation([], amounts, {toGM: true});
    sendAuditToGM(origin, [], amounts, {toGM: true});
  } else {
    const targetActor = game.actors.get(selected.id);
    await playerConfirmation(targetActor ? [targetActor] : [], amounts);
    sendAuditToGM(origin, targetActor ? [targetActor] : [], amounts);
  }

  ui.notifications.info("Деньги переданы.");
  app.close();
}

function pcgaRemoteCurrencyTransfer(origin, recipient, amounts) {
  return new Promise(resolve => {
    const requestId = foundry.utils.randomID();

    const handler = payload => {
      if (payload?.type !== "remote-currency-result" || payload?.requestId !== requestId) return;
      game.socket.off(SOCKET, handler);
      resolve(payload);
    };

    game.socket.on(SOCKET, handler);
    game.socket.emit(SOCKET, {
      type: "remote-currency-request",
      requestId,
      originActorUuid: origin.uuid,
      targetActorId: recipient.id,
      amounts
    });

    setTimeout(() => {
      game.socket.off(SOCKET, handler);
      resolve({ok: false, error: "ГМ не ответил на запрос передачи."});
    }, 8000);
  });
}

function pcgaFindButton(root, text) {
  return Array.from(root.querySelectorAll("button")).find(button =>
    String(button.textContent ?? "").trim().toLowerCase() === text.toLowerCase()
  ) ?? null;
}

function injectSendToGM(app) {
  if (game.user.isGM) return;
  const root = app.element;
  if (!(root instanceof HTMLElement)) return;
  if (root.querySelector(".pcga-send-gm, .pcga-choose-player")) return;

  const transferButton = pcgaFindButton(root, "Передать");
  if (!transferButton?.parentElement) return;

  const choosePlayer = document.createElement("button");
  choosePlayer.type = "button";
  choosePlayer.className = "pcga-choose-player";
  choosePlayer.innerHTML = '<i class="fa-solid fa-users"></i> Выбор игрока';
  choosePlayer.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    pcgaOpenPlayerTransferDialog(app);
  });

  const sendGM = document.createElement("button");
  sendGM.type = "button";
  sendGM.className = "pcga-send-gm";
  sendGM.innerHTML = '<i class="fa-solid fa-user-shield"></i> Передать ГМу';
  sendGM.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    sendToGM(app);
  });

  transferButton.insertAdjacentElement("afterend", choosePlayer);
  choosePlayer.insertAdjacentElement("afterend", sendGM);
}

const RECENT_ITEM_DESTINATIONS = [];
const PENDING_ITEM_DELETIONS = new Map();
const ITEM_DESTINATION_TTL = 2200;
const ITEM_PILES_TRADE_HOOK = "item-piles-tradeComplete";

function itemQuantity(item) {
  return Math.max(1, Number(item?.system?.quantity ?? 1) || 1);
}

function itemIdentity(item) {
  return [
    item?.type ?? "",
    String(item?.name ?? "").trim().toLowerCase(),
    String(item?.system?.identifier ?? "").trim().toLowerCase()
  ].join("|");
}

function pruneItemDestinations() {
  const now = Date.now();
  for (let i = RECENT_ITEM_DESTINATIONS.length - 1; i >= 0; i--) {
    if (now - RECENT_ITEM_DESTINATIONS[i].time > ITEM_DESTINATION_TTL) {
      RECENT_ITEM_DESTINATIONS.splice(i, 1);
    }
  }
}

function rememberItemDestination(item, quantity, userId) {
  if (game.user.isGM) return;
  if (userId && userId !== game.user.id) return;
  if (item?.parent?.documentName !== "Actor") return;

  const key = `${item.parent.uuid}|${item.id}`;
  const pending = PENDING_ITEM_DELETIONS.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    PENDING_ITEM_DELETIONS.delete(key);
  }

  pruneItemDestinations();

  RECENT_ITEM_DESTINATIONS.push({
    identity: itemIdentity(item),
    targetActorUuid: item.parent.uuid,
    targetActorName: item.parent.name,
    targetActorType: item.parent.type,
    itemName: item.name,
    itemImg: item.img,
    quantity,
    time: Date.now()
  });
}

function takeMatchingDestination(item) {
  pruneItemDestinations();

  const identity = itemIdentity(item);
  const sourceQty = Math.max(1, itemQuantity(item));

  // Prefer exact quantity, then any matching recent destination.
  let index = RECENT_ITEM_DESTINATIONS.findIndex(entry =>
    entry.identity === identity &&
    entry.targetActorUuid !== item?.parent?.uuid &&
    entry.quantity === sourceQty
  );

  if (index < 0) {
    index = RECENT_ITEM_DESTINATIONS.findIndex(entry =>
      entry.identity === identity &&
      entry.targetActorUuid !== item?.parent?.uuid
    );
  }

  if (index < 0) return null;
  return RECENT_ITEM_DESTINATIONS.splice(index, 1)[0];
}

function sendItemAuditToGM(payload) {
  if (game.user.isGM) return;
  game.socket.emit(SOCKET, {
    type: "item-audit",
    ...payload
  });
}

async function playerItemConfirmation(payload) {
  if (game.user.isGM) return;

  const action = payload?.action === "delete" ? "Удаление предмета" : "Передача предмета";
  const success = payload?.action === "delete" ? "Успешно удалено ✓" : "Успешно передано ✓";

  const target = foundry.utils.escapeHTML(payload?.targetActorName ?? "");
  const itemName = foundry.utils.escapeHTML(payload?.itemName ?? "Предмет");
  const img = foundry.utils.escapeHTML(payload?.itemImg ?? "icons/svg/item-bag.svg");
  const qty = Math.max(1, Number(payload?.quantity ?? 1) || 1);

  const sourceType = String(payload?.sourceActorType ?? "").toLowerCase();
  const targetType = String(payload?.targetActorType ?? "").toLowerCase();
  const sourceName = foundry.utils.escapeHTML(payload?.sourceActorName ?? "");

  const route = payload?.action === "delete"
    ? ""
    : sourceType === "group" && targetType !== "group"
      ? `Вы взяли ← [ <strong>${sourceName}</strong> ]<br>`
      : `Вы передали → [ <strong>${target}</strong> ]<br>`;

  const heading = payload?.action === "delete"
    ? `❌ <strong>Удаление предмета</strong>`
    : `📦 <strong>Передача предмета</strong>`;

  const content = `
    <div class="pcga-item-audit">
      ${heading}<br>
      ${route}
      <div class="pcga-item-line">
        <img src="${img}" alt="${itemName}">
        <span>${itemName}${qty > 1 ? ` × <strong>${qty}</strong>` : ""}</span>
      </div>
      <strong>${success}</strong>
    </div>`;

  await ChatMessage.create({
    content,
    whisper: [game.user.id],
    speaker: ChatMessage.getSpeaker()
  });
}

async function createGMItemAuditMessage(payload) {
  if (!game.user.isGM) return;

  if (payload?.action === "trade-summary") {
    const primaryGM = primaryActiveGM();
    if (primaryGM && primaryGM.id !== game.user.id) return;
    const hasMoney=m=>m&&(m.gp||m.sp||m.cp);
    const moneyLine=m=>{if(!hasMoney(m))return"";const a=[];if(m.gp)a.push(`<strong>${m.gp}</strong> золота`);if(m.sp)a.push(`<strong>${m.sp}</strong> серебра`);if(m.cp)a.push(`<strong>${m.cp}</strong> меди`);return `<div class="pcga-trade-money">Монеты: ${a.join(", ")}</div>`;};
    const section=(title,rows=[],money={})=>(rows.length||hasMoney(money))?`<div class="pcga-trade-section"><strong>${title}</strong>${rows.map(r=>`<div class="pcga-item-line"><img src="${foundry.utils.escapeHTML(r.img??"icons/svg/item-bag.svg")}" alt=""><span>${foundry.utils.escapeHTML(r.name??"Предмет")}${Number(r.qty)>1?` × <strong>${Number(r.qty)}</strong>`:""}</span></div>`).join("")}${moneyLine(money)}</div>`:"";
    const content=`<div class="pcga-item-audit pcga-trade-audit"><strong>⇄ Обмен</strong><br><strong>[ ${foundry.utils.escapeHTML(payload.sourceActorName??"Игрок")} ]</strong>${section("Отдал:",payload.gave,payload.gaveMoney)}${section("Получил:",payload.got,payload.gotMoney)}</div>`;
    await ChatMessage.create({content,whisper:[game.user.id],speaker:ChatMessage.getSpeaker()});
    return;
  }

  const primaryGM = primaryActiveGM();
  if (primaryGM && primaryGM.id !== game.user.id) return;

  const action = payload?.action === "delete" ? "Удаление предмета" : "Передача предмета";
  const success = payload?.action === "delete" ? "Успешно удалено ✓" : "Успешно передано ✓";

  const actorName = foundry.utils.escapeHTML(payload?.sourceActorName ?? "Игрок");
  const targetName = foundry.utils.escapeHTML(payload?.targetActorName ?? "");
  const itemName = foundry.utils.escapeHTML(payload?.itemName ?? "Предмет");
  const img = foundry.utils.escapeHTML(payload?.itemImg ?? "icons/svg/item-bag.svg");
  const qty = Math.max(1, Number(payload?.quantity ?? 1) || 1);

  const route = payload?.action === "delete"
    ? `<strong>[ ${actorName} ]</strong>`
    : `${actorName} <strong>→ [ ${targetName} ]</strong>`;

  const heading = payload?.action === "delete"
    ? `❌ <strong>Удаление предмета</strong>`
    : `📦 <strong>Передача предмета</strong>`;

  const content = `
    <div class="pcga-item-audit">
      ${heading}<br>
      ${route}<br>
      <div class="pcga-item-line">
        <img src="${img}" alt="${itemName}">
        <span>${itemName}${qty > 1 ? ` × <strong>${qty}</strong>` : ""}</span>
      </div>
      <strong>${success}</strong>
    </div>`;

  await ChatMessage.create({
    content,
    whisper: [game.user.id],
    speaker: ChatMessage.getSpeaker()
  });
}



async function createGMItemUseMessage(payload) {
  if (!game.user.isGM) return;

  const primaryGM = primaryActiveGM();
  if (primaryGM && primaryGM.id !== game.user.id) return;

  const actorName = foundry.utils.escapeHTML(payload?.actorName ?? "Игрок");
  const itemName = foundry.utils.escapeHTML(payload?.itemName ?? "Предмет");
  const img = foundry.utils.escapeHTML(payload?.itemImg ?? "icons/svg/item-bag.svg");

  const content = `
    <div class="pcga-item-audit">
      ⚡ <strong>Использование предмета</strong><br>
      <strong>[ ${actorName} ]</strong><br>
      <div class="pcga-item-line">
        <img src="${img}" alt="${itemName}">
        <span>${itemName} × <strong>1</strong></span>
      </div>
      <strong>Успешно использовано ✓</strong>
    </div>`;

  await ChatMessage.create({
    content,
    whisper: [game.user.id],
    speaker: ChatMessage.getSpeaker()
  });
}



function pcgaOrderActorWallets() {
  const reorder = root => {
    if (!(root instanceof HTMLElement)) return;
    if (root.classList.contains("currency-manager") || root.closest?.(".currency-manager")) return;

    const currencyNodes = [...root.querySelectorAll("i.currency.cp, span.currency.cp")];
    for (const cpIcon of currencyNodes) {
      const cp = cpIcon.closest("label, li, .currency, .currency-item, .currency-entry") ?? cpIcon.parentElement;
      if (!cp?.parentElement) continue;
      const parent = cp.parentElement;

      const siblings = [...parent.children];
      const find = key => siblings.find(el => el.querySelector?.(`i.currency.${key}, span.currency.${key}`));
      const sp = find("sp");
      const gp = find("gp");
      if (!sp || !gp || cp === sp || cp === gp || sp === gp) continue;

      // Only act on a compact wallet row/container containing all three currencies.
      parent.append(cp, sp, gp);
    }
  };

  reorder(document.body);
  const observer = new MutationObserver(ms => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n instanceof HTMLElement) reorder(n);
    }
  });
  observer.observe(document.body, {childList: true, subtree: true});
}

Hooks.once("ready", () => {
  pcgaOrderActorWallets();
  if (game.system.id !== "dnd5e") return;

  const pcgaSocketHandler = async payload => {
    try {
      if (payload?.type === "audit") {
        await createGMAuditMessage(payload);
      } else if (payload?.type === "item-audit") {
        await createGMItemAuditMessage(payload);
      } else if (payload?.type === "remote-currency-request") {
        await pcgaGMRemoteCurrency(payload);
      } else if (payload?.type === "ims-item-use") {
        await createGMItemUseMessage(payload);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | GM audit socket failed`, err);
    }
  };

  game.socket.on(SOCKET, pcgaSocketHandler);
  if (LEGACY_SOCKET !== SOCKET) game.socket.on(LEGACY_SOCKET, pcgaSocketHandler);

  const CurrencyManager = game.dnd5e?.applications?.CurrencyManager;
  if (!CurrencyManager) {
    console.error(`${MODULE_ID} | D&D5e CurrencyManager not found.`);
    ui.notifications.warn("LipatoS - Аудит валюты и предметов: CurrencyManager не найден.");
    return;
  }

  // Standard D&D5e transfers:
  // - GM receives the old audit message
  // - player receives a separate clean confirmation
  if (!CurrencyManager.__pcgaTransferPatched) {
    const originalTransfer = CurrencyManager.transferCurrency;

    CurrencyManager.transferCurrency = async function(origin, destinations, amounts) {
      const auditAmounts = Object.fromEntries(
        Object.entries(amounts ?? {}).map(([key, value]) => [key, Number(value) || 0])
      );

      const auditDestinations = Array.isArray(destinations) ? [...destinations] : destinations;
      const result = await originalTransfer.call(this, origin, destinations, amounts);

      if (!game.user.isGM) {
        try {
          sendAuditToGM(origin, auditDestinations, auditAmounts);
          await playerConfirmation(auditDestinations, auditAmounts);
        } catch (err) {
          console.error(`${MODULE_ID} | Could not create transfer messages`, err);
        }
      }

      return result;
    };

    Object.defineProperty(CurrencyManager, "__pcgaTransferPatched", {value: true});
  }

  // Add "Передать ГМу" to the native transfer window.
  if (!CurrencyManager.prototype.__pcgaRenderPatched) {
    const originalRender = CurrencyManager.prototype._onRender;

    CurrencyManager.prototype._onRender = async function(context, options) {
      if (originalRender) await originalRender.call(this, context, options);
      injectSendToGM(this);
    };

    Object.defineProperty(CurrencyManager.prototype, "__pcgaRenderPatched", {value: true});
  }


  // Track transfer destination when a new Item is created on another Actor.
  Hooks.on("createItem", (item, options, userId) => {
    rememberItemDestination(item, itemQuantity(item), userId);
  });

  // Track quantity changes.
  // +delta = destination received part of a stack
  // -delta = source gave part of a stack
  Hooks.on("updateItem", async (item, changes, options, userId) => {
    if (game.user.isGM) return;
    if (userId && userId !== game.user.id) return;
    if (item?.parent?.documentName !== "Actor") return;

    const changedQty = foundry.utils.getProperty(changes, "system.quantity");
    if (changedQty === undefined) return;

    const newQty = Number(changedQty);
    const oldQty = Number(item._pcgaPreviousQuantity ?? NaN);
    const delta = Number.isFinite(oldQty) ? (newQty - oldQty) : NaN;

    if (!Number.isFinite(delta) || delta === 0) return;

    // Destination side of a partial transfer / auto-stack.
    if (delta > 0) {
      rememberItemDestination(item, delta, userId);
      return;
    }

    // Source side of a PARTIAL transfer.
    // Pair it with the destination increase/create recorded moments earlier.
    const movedQty = Math.abs(delta);
    pruneItemDestinations();

    const identity = itemIdentity(item);
    let index = RECENT_ITEM_DESTINATIONS.findIndex(entry =>
      entry.identity === identity &&
      entry.targetActorUuid !== item.parent.uuid &&
      entry.quantity === movedQty
    );

    if (index < 0) {
      index = RECENT_ITEM_DESTINATIONS.findIndex(entry =>
        entry.identity === identity &&
        entry.targetActorUuid !== item.parent.uuid
      );
    }

    if (index < 0) return; // ordinary manual quantity decrease: do not treat as transfer

    const paired = RECENT_ITEM_DESTINATIONS.splice(index, 1)[0];

    const payload = {
      action: "transfer",
      sourceActorUuid: item.parent.uuid,
      sourceActorName: item.parent.name,
      sourceActorType: item.parent.type,
      targetActorUuid: paired.targetActorUuid,
      targetActorName: paired.targetActorName,
      targetActorType: paired.targetActorType,
      itemName: item.name,
      itemImg: item.img,
      quantity: movedQty
    };

    try {
      sendItemAuditToGM(payload);
      await playerItemConfirmation(payload);
    } catch (err) {
      console.error(`${MODULE_ID} | Partial item transfer audit failed`, err);
    }
  });

  // Capture quantity before update so updateItem can calculate the increase.
  Hooks.on("preUpdateItem", (item, changes, options, userId) => {
    if (game.user.isGM) return;
    if (userId && userId !== game.user.id) return;
    const changedQty = foundry.utils.getProperty(changes, "system.quantity");
    if (changedQty === undefined) return;
    item._pcgaPreviousQuantity = itemQuantity(item);
  });

  Hooks.on("deleteItem", async (item, options, userId) => {
    // Technical deletions are not "Удаление предмета" for audit purposes.
    if (options?.itemMoveStackMerge) return;
    if (options?.itemMoveStackUse) return;

    if (game.user.isGM) return;
    if (userId && userId !== game.user.id) return;
    if (item?.parent?.documentName !== "Actor") return;

    const paired = takeMatchingDestination(item);

    const payload = paired ? {
      action: "transfer",
      sourceActorUuid: item.parent.uuid,
      sourceActorName: item.parent.name,
      sourceActorType: item.parent.type,
      targetActorUuid: paired.targetActorUuid,
      targetActorName: paired.targetActorName,
      targetActorType: paired.targetActorType,
      itemName: item.name,
      itemImg: item.img,
      quantity: itemQuantity(item)
    } : {
      action: "delete",
      sourceActorUuid: item.parent.uuid,
      sourceActorName: item.parent.name,
      sourceActorType: item.parent.type,
      itemName: item.name,
      itemImg: item.img,
      quantity: itemQuantity(item)
    };

    if (!paired && payload.action === "delete") {
      const key = `${item.parent.uuid}|${item.id}`;
      const timer = setTimeout(async () => {
        const pending = PENDING_ITEM_DELETIONS.get(key);
        if (!pending) return;
        PENDING_ITEM_DELETIONS.delete(key);
        try {
          sendItemAuditToGM(pending.payload);
          await playerItemConfirmation(pending.payload);
        } catch (err) {
          console.error(`${MODULE_ID} | Delayed item audit failed`, err);
        }
      }, 1200);
      PENDING_ITEM_DELETIONS.set(key, { payload, timer });
      return;
    }

    try {
      sendItemAuditToGM(payload);
      await playerItemConfirmation(payload);
    } catch (err) {
      console.error(`${MODULE_ID} | Item audit failed`, err);
    }
  });

  Hooks.on(ITEM_PILES_TRADE_HOOK, async (instigator, left, right, tradeId) => {
    try {
      const me=game.user.id;
      const mine=left?.user===me?left:right?.user===me?right:null;
      const other=mine===left?right:mine===right?left:null;
      if(!mine||!other)return;

      for(const entry of (mine.items??[])){
        let id=entry.id??entry._id??"";
        if(!id&&entry.uuid)id=String(entry.uuid).split(".").pop();
        const key=`${mine.actor}|${id}`;
        const pending=PENDING_ITEM_DELETIONS.get(key);
        if(pending){clearTimeout(pending.timer);PENDING_ITEM_DELETIONS.delete(key);}
      }

      const normalize=async(entries=[])=>{
        const rows=[];
        for(const e of entries){
          const qty=Math.max(1,Number(e.quantity??1)||1);
          let doc=null;
          if(e.uuid)doc=await fromUuid(e.uuid).catch(()=>null);
          rows.push({name:e.name??doc?.name??"Предмет",img:e.img??doc?.img??"icons/svg/item-bag.svg",qty});
        }
        return rows;
      };
      const gave=await normalize(mine.items??[]);
      const got=await normalize(other.items??[]);

      const normalizeCurrencies=(entries=[])=>{
        const out={gp:0,sp:0,cp:0};
        for(const e of entries){
          const text=`${e.name??""} ${e.path??""} ${e.abbreviation??""}`.toLowerCase();
          const qty=Math.max(0,Number(e.quantity??e.qty??0)||0);
          if(/золот|gold|\bgp\b/.test(text))out.gp+=qty;
          else if(/сереб|silver|\bsp\b/.test(text))out.sp+=qty;
          else if(/мед|copper|\bcp\b/.test(text))out.cp+=qty;
        }
        return out;
      };
      const gaveMoney=normalizeCurrencies(mine.currencies??mine.currency??[]);
      const gotMoney=normalizeCurrencies(other.currencies??other.currency??[]);
      const hasMoney=m=>m.gp||m.sp||m.cp;
      if(!gave.length&&!got.length&&!hasMoney(gaveMoney)&&!hasMoney(gotMoney))return;

      const section=(title,rows)=>rows.length?`<div class="pcga-trade-section"><strong>${title}</strong>${rows.map(r=>`<div class="pcga-item-line"><img src="${foundry.utils.escapeHTML(r.img)}" alt=""><span>${foundry.utils.escapeHTML(r.name)}${r.qty>1?` × <strong>${r.qty}</strong>`:""}</span></div>`).join("")}</div>`:"";
      const moneyLine=m=>{
        const parts=[];
        if(m.gp)parts.push(`<strong>${m.gp}</strong> золота`);
        if(m.sp)parts.push(`<strong>${m.sp}</strong> серебра`);
        if(m.cp)parts.push(`<strong>${m.cp}</strong> меди`);
        return parts.length?`<div class="pcga-trade-money">Монеты: ${parts.join(", ")}</div>`:"";
      };
      const side=(title,items,money)=>(items.length||hasMoney(money))?`<div class="pcga-trade-section"><strong>${title}</strong>${items.map(r=>`<div class="pcga-item-line"><img src="${foundry.utils.escapeHTML(r.img)}" alt=""><span>${foundry.utils.escapeHTML(r.name)}${r.qty>1?` × <strong>${r.qty}</strong>`:""}</span></div>`).join("")}${moneyLine(money)}</div>`:"";

      const content=`<div class="pcga-item-audit pcga-trade-audit"><strong>⇄ Обмен</strong><br>${side("Вы отдали:",gave,gaveMoney)}${side("Вы получили:",got,gotMoney)}</div>`;
      await ChatMessage.create({content,whisper:[game.user.id],speaker:ChatMessage.getSpeaker()});

      const actor=await fromUuid(mine.actor).catch(()=>null);
      sendItemAuditToGM({action:"trade-summary",sourceActorName:actor?.name??"Игрок",gave,got,gaveMoney,gotMoney});
    }catch(err){console.error(`${MODULE_ID} | Item Piles trade audit failed`,err);}
  });

  console.log(`${MODULE_ID} | Ready v27.`);


});
