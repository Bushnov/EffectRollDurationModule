/**
 * Effect Roll Duration
 *
 * Adds a "Rolls" duration to Active Effects. An effect set to this mode is deleted
 * once its actor has made `remainingRolls` d20 rolls.
 *
 * DATA STORAGE (on the ActiveEffect document):
 *   effect.flags["effect-roll-duration"].durationMode   -> "none" | "rolls"
 *   effect.flags["effect-roll-duration"].remainingRolls -> integer >= 0
 * Flags are used so nothing in the core/dnd5e ActiveEffect schema is altered.
 * The counter lives on each effect document, so every actor's copy counts independently.
 *
 * HOOKS USED:
 *   renderActiveEffectConfig (all clients)  - injects the form fields into the sheet.
 *   dnd5e.postRollAttack, dnd5e.rollSavingThrow, dnd5e.rollAbilityCheck,
 *   dnd5e.rollSkill, dnd5e.rollToolCheck    - fire ONLY on the client that rolled.
 *
 * FLOW: rolling client -> (socket) -> active GM client -> decrement effects.
 * If no GM is connected the roll is not counted.
 *
 * DEBUGGING: enable "Debug logging" in module settings (per user). Every step is logged
 * to the console with the prefix "[erd]" and kept in a ring buffer. In the console:
 *   game.modules.get("effect-roll-duration").api.dump(actor)   // effects + counters
 *   game.modules.get("effect-roll-duration").api.exportLog()   // download the log as JSON
 */

const MODULE_ID = "effect-roll-duration";
const SOCKET = `module.${MODULE_ID}`;
const MODE_ROLLS = "rolls";
const LOG_LIMIT = 2000;

/* -------------------------------------------- */
/*  Logging                                     */
/* -------------------------------------------- */

const logBuffer = [];

/** True once settings are registered and the user turned logging on. */
function debugOn() {
  try { return game.settings.get(MODULE_ID, "debug"); } catch { return false; }
}

/**
 * Record a log entry. Nothing is recorded or printed unless "Debug logging" is enabled,
 * so enable it (and reload) before the run you want evidence of. Entries go to the
 * console and into a ring buffer that exportLog() writes to a file.
 */
function log(event, data = {}) {
  if (!debugOn()) return;
  const entry = {
    t: new Date().toISOString(),
    user: game.user?.name,
    isGM: game.user?.isGM,
    isActiveGM: game.users?.activeGM === game.user,
    event,
    ...data
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_LIMIT) logBuffer.shift();
  console.log(`[erd] ${event}`, data);
}

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "debug", {
    name: "EFFECT-ROLL-DURATION.Settings.Debug",
    hint: "EFFECT-ROLL-DURATION.Settings.DebugHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  mod.api = { dump, exportLog, simulateRoll, logBuffer };

  log("ready", {
    foundry: game.version,
    system: `${game.system.id} ${game.system.version}`,
    module: mod.version,
    activeGM: game.users.activeGM?.name ?? null
  });

  // Socket receiver: runs on every client but acts only on the active GM.
  game.socket.on(SOCKET, async (data, senderId) => {
    const isActiveGM = game.users.activeGM === game.user;
    log("socket:received", { data, senderId, isActiveGM });
    if (!isActiveGM) return;
    const actor = await fromUuid(data?.actorUuid);
    const sender = game.users.get(senderId);
    if (!(actor instanceof Actor) || !sender) {
      return log("socket:rejected", { reason: "actor or sender not found", data });
    }
    // The sender must own the actor, so a player cannot burn down another character's effects.
    if (!actor.testUserPermission(sender, "OWNER")) {
      return log("socket:rejected", { reason: "sender does not own actor", sender: sender.name, actor: actor.name });
    }
    queueDecrement(actor.uuid, `socket from ${sender.name}`);
  });
});

/* -------------------------------------------- */
/*  UI injection                                */
/* -------------------------------------------- */

/**
 * Hook: renderActiveEffectConfig(app, html, context, options)
 * Foundry v14 sheets are ApplicationV2, so `html` is an HTMLElement (not jQuery).
 *
 * We add a "Rolls" <option> to the core duration "units" select. Core validates that
 * field against its own choices, so a submitted "rolls" would be rejected. Instead of
 * patching the schema, while "Rolls" is selected we strip the select's `name` so core's
 * `duration.units` is simply not submitted (it keeps its previous value), and a hidden
 * input saves our own flag. Inputs named `flags.<module-id>.<key>` are saved by the
 * sheet's normal submit handling.
 */
Hooks.on("renderActiveEffectConfig", (app, html) => {
  const root = html instanceof HTMLElement ? html : html[0];

  // Diagnostic: report the real sheet structure so selectors can be verified.
  log("sheet:render", {
    effect: app.document?.uuid,
    parts: [...root.querySelectorAll("[data-application-part]")].map(e => e.dataset.applicationPart),
    tabs: [...root.querySelectorAll("[data-tab]")].map(e => e.dataset.tab),
    selects: [...root.querySelectorAll("select")].map(s => ({
      name: s.name,
      options: [...s.options].map(o => o.value)
    })),
    alreadyInjected: !!root.querySelector(".erd-remaining")
  });
  if (root.querySelector(".erd-remaining")) return;

  const effect = app.document;
  const isRolls = effect.getFlag(MODULE_ID, "durationMode") === MODE_ROLLS;
  const remaining = effect.getFlag(MODULE_ID, "remainingRolls") ?? 1;
  const t = key => game.i18n.localize(`EFFECT-ROLL-DURATION.${key}`);

  const select = root.querySelector('select[name="duration.units"]');
  if (!select) {
    return console.warn(`${MODULE_ID} | duration units select not found; Rolls option not added.`);
  }

  const group = document.createElement("div");
  group.classList.add("form-group", "erd-remaining");
  group.hidden = !isRolls;
  group.innerHTML = `
    <label>${t("Remaining")}</label>
    <div class="form-fields">
      <input type="hidden" name="flags.${MODULE_ID}.durationMode" value="${isRolls ? MODE_ROLLS : "none"}">
      <input type="number" name="flags.${MODULE_ID}.remainingRolls"
             value="${remaining}" min="1" step="1" data-dtype="Number">
    </div>
    <p class="hint">${t("RemainingHint")}</p>`;
  const modeInput = group.querySelector('input[type="hidden"]');

  // Keep the count a whole number >= 1 (T2 showed decimals are otherwise stored as typed).
  const countInput = group.querySelector('input[type="number"]');
  countInput.addEventListener("change", () => {
    countInput.value = Math.max(1, Math.round(Number(countInput.value) || 1));
  });

  const coreName = select.name;
  const option = new Option(t("ModeRolls"), MODE_ROLLS);
  select.append(option);
  select.closest(".form-group").after(group);

  const sync = () => {
    const rolls = select.value === MODE_ROLLS;
    group.hidden = !rolls;
    modeInput.value = rolls ? MODE_ROLLS : "none";
    if (rolls) select.removeAttribute("name");
    else select.name = coreName;
    log("sheet:units-changed", { value: select.value, selectHasName: select.hasAttribute("name"), mode: modeInput.value });
  };
  select.addEventListener("change", sync);
  if (isRolls) {
    option.selected = true;
    sync();
  }
  log("sheet:injected", { coreName, isRolls, remaining });
});

/* -------------------------------------------- */
/*  Roll tracking                               */
/* -------------------------------------------- */

/**
 * dnd5e roll hooks (verified against dnd5e 6.0.6). Each fires once per roll action, only
 * on the client that made the roll. Initiative and death saves are intentionally absent.
 * Concentration is a saving throw internally, so rollSavingThrow already covers it;
 * do not also listen to dnd5e.rollConcentration or it would count twice.
 * Only the non-"V2" names are used, since dnd5e fires both for the same roll.
 *
 * Attacks use postRollAttack (the activity is `data.subject`, so the actor is its
 * `.actor`); the others pass the actor directly as `data.subject`.
 */
Hooks.on("dnd5e.postRollAttack", (rolls, data) => report("postRollAttack", data?.subject?.actor, rolls));
for (const name of ["rollAbilityCheck", "rollSkill", "rollToolCheck"]) {
  Hooks.on(`dnd5e.${name}`, (rolls, data) => report(name, data?.subject, rolls));
}

/**
 * Death saves are made through the saving throw function, so they fire this hook too
 * (observed in testing). The reliable marker is system.type "death" on the roll's chat
 * message (confirmed in testing); options.saveType was undefined there, but is kept as a
 * harmless extra check. If a roll is made with no chat message, a death save cannot be
 * recognised and would be counted.
 */
Hooks.on("dnd5e.rollSavingThrow", (rolls, data) => {
  const saveType = rolls?.[0]?.options?.saveType;
  const messageType = rolls?.[0]?.parent?.system?.type;
  if (saveType === "death" || messageType === "death") {
    return log("hook:ignored", { hook: "rollSavingThrow", reason: "death save", saveType, messageType });
  }
  report("rollSavingThrow", data?.subject, rolls, { saveType, messageType });
});

/** Runs on the rolling client: hand the actor to the active GM. */
function report(hookName, actor, rolls, extra = {}) {
  log("hook:fired", {
    ...extra,
    hook: hookName,
    actor: actor?.uuid ?? null,
    actorName: actor?.name ?? null,
    totals: rolls?.map(r => r.total)
  });
  if (!actor) return log("report:dropped", { reason: "no actor on hook data" });
  const gm = game.users.activeGM;
  if (!gm) return log("report:dropped", { reason: "no active GM" });
  if (gm === game.user) {
    log("report:local", { actor: actor.uuid });
    queueDecrement(actor.uuid, `local ${hookName}`);
  } else {
    log("report:socket-emit", { actor: actor.uuid, to: gm.name });
    game.socket.emit(SOCKET, { actorUuid: actor.uuid });
  }
}

// Serialize updates so rapid back-to-back rolls can't read a stale counter.
let queue = Promise.resolve();
function queueDecrement(actorUuid, source) {
  queue = queue
    .then(async () => {
      const actor = await fromUuid(actorUuid);
      if (!actor) return log("decrement:skipped", { reason: "actor not found", actorUuid, source });
      log("decrement:start", { actor: actor.name, actorUuid, source });
      await decrementEffects(actor);
    })
    .catch(err => console.error(MODULE_ID, err));
}

/**
 * Decrement every enabled "Rolls" effect on the actor, deleting those that reach 0.
 * allApplicableEffects() includes effects transferred from the actor's items.
 */
async function decrementEffects(actor) {
  let touched = 0;
  for (const effect of actor.allApplicableEffects()) {
    if (effect.getFlag(MODULE_ID, "durationMode") !== MODE_ROLLS) continue;
    // Disabled, or suppressed (e.g. a transferred effect from an unequipped item): not in play.
    if (effect.disabled || effect.isSuppressed) {
      log("decrement:skip-disabled", { effect: effect.uuid, name: effect.name, disabled: effect.disabled, suppressed: effect.isSuppressed });
      continue;
    }
    touched++;
    const before = effect.getFlag(MODULE_ID, "remainingRolls") ?? 0;
    const left = before - 1;
    if (left <= 0) {
      log("decrement:delete", { effect: effect.uuid, name: effect.name, before, after: 0 });
      await effect.delete();
    } else {
      log("decrement:update", { effect: effect.uuid, name: effect.name, before, after: left });
      await effect.setFlag(MODULE_ID, "remainingRolls", left);
    }
  }
  if (!touched) log("decrement:none", { actor: actor.name, reason: "no enabled Rolls effects" });
}

/* -------------------------------------------- */
/*  Diagnostic API (game.modules.get(id).api)   */
/* -------------------------------------------- */

/** Resolve an Actor from an Actor, UUID, name, or the first controlled token. */
function resolveActor(ref) {
  if (ref instanceof Actor) return ref;
  if (typeof ref === "string") return fromUuidSync(ref) ?? game.actors.getName(ref);
  return canvas.tokens?.controlled[0]?.actor ?? null;
}

/** Print a table of every effect on the actor with its Rolls mode and counter. */
function dump(ref) {
  const actor = resolveActor(ref);
  if (!actor) return console.warn("[erd] dump: no actor (pass an actor, uuid, name, or select a token)");
  const rows = [...actor.allApplicableEffects()].map(e => ({
    name: e.name,
    uuid: e.uuid,
    disabled: e.disabled,
    mode: e.getFlag(MODULE_ID, "durationMode") ?? "(unset)",
    remaining: e.getFlag(MODULE_ID, "remainingRolls") ?? "(unset)",
    units: e.duration?.units,
    expiry: e.duration?.expiry
  }));
  console.log(`[erd] effects on ${actor.name}`);
  console.table(rows);
  return rows;
}

/**
 * Run the full report path (local or socket) for an actor WITHOUT rolling dice.
 * Useful for isolating the socket/GM logic from dnd5e's hooks.
 */
function simulateRoll(ref) {
  const actor = resolveActor(ref);
  if (!actor) return console.warn("[erd] simulateRoll: no actor");
  report("simulateRoll", actor, []);
}

/** Download the buffered log as a JSON file (attach this as test evidence). */
function exportLog() {
  const name = `erd-log-${game.user.name}-${Date.now()}.json`;
  saveDataToFile(JSON.stringify(logBuffer, null, 2), "application/json", name);
  return logBuffer.length;
}
