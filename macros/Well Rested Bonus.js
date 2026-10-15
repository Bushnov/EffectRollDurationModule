// Well Rested Bonus
// Prompts for a die size, then gives every player character an effect that adds that die
// to their next d20 roll (attack, saving throw, ability check, skill check, tool check).
// The effect removes itself after one roll via the "Effect Roll Duration" module.
// Works on Foundry v14 with dnd5e 5.3.3 or later (including 6.x).

const MODULE_ID = "effect-roll-duration";

if (!game.modules.get(MODULE_ID)?.active) {
  ui.notifications.error("Effect Roll Duration is not active; the bonus would never expire. Aborting.");
  return;
}

// Ask which die to use. DialogV2 replaces the deprecated Dialog class.
const dieOptions = ["1d4", "1d6", "1d8", "1d10", "1d12"];
const chosenDie = await foundry.applications.api.DialogV2.prompt({
  window: { title: "Apply Well Rested Bonus" },
  content: `
    <div class="form-group">
      <label>Choose Bonus Die:</label>
      <div class="form-fields">
        <select name="die">
          ${dieOptions.map(d => `<option value="${d}" ${d === "1d8" ? "selected" : ""}>${d}</option>`).join("")}
        </select>
      </div>
    </div>`,
  ok: {
    label: "Apply to All Players",
    icon: "fa-solid fa-check",
    callback: (event, button) => button.form.elements.die.value
  },
  rejectClose: false // closing the dialog returns null instead of throwing
});
if (!chosenDie) return;

// Bonus fields differ by dnd5e version. Each is a formula string, and "add" with a leading
// "+" appends to any existing bonus (e.g. "1" becomes "1 +1d8").
//   dnd5e 6.x: system.rolls.*.bonus (rolls.attack.bonus covers every attack type)
//   dnd5e 5.x: system.bonuses.* (attacks are per type; abilities.check also covers skills/tools)
// Known limitation (confirmed in the dnd5e 5.3.3 source): the shared check bonus is also
// added to initiative rolls, and the shared save bonus is also added to death saves. The
// module does not count those rolls, so the die is rolled but the effect is not used up.
const dnd5e6 = foundry.utils.isNewerVersion(game.system.version, "5.99.99");
const bonusKeys = dnd5e6
  ? [
    "system.rolls.attack.bonus",
    "system.rolls.ability.check.bonus",
    "system.rolls.ability.save.bonus"
  ]
  : [
    "system.bonuses.mwak.attack",
    "system.bonuses.rwak.attack",
    "system.bonuses.msak.attack",
    "system.bonuses.rsak.attack",
    "system.bonuses.abilities.check",
    "system.bonuses.abilities.save"
  ];

const makeChange = (key, value) => ({ key, type: "add", value });

const effectData = {
  name: `Well Rested Bonus (+${chosenDie})`,
  img: "icons/magic/control/buff-luck-fortune-rainbow.webp",
  changes: bonusKeys.map(key => makeChange(key, `+${chosenDie}`)),
  flags: {
    // Effect Roll Duration: delete this effect after one counted d20 roll.
    [MODULE_ID]: { durationMode: "rolls", remainingRolls: 1 }
  }
};

// Player characters = "character" actors that a player owns. Utility actors that are owned
// by a player but never roll (for example a camera or a party bank) also match; the effect
// is harmless on them.
const playerActors = game.actors.filter(a => a.hasPlayerOwner && a.type === "character");
if (!playerActors.length) {
  ui.notifications.warn("No player-controlled characters found.");
  return;
}

let appliedCount = 0;
let replacedCount = 0;
for (const actor of playerActors) {
  // Replace any existing Well Rested Bonus (unused, or a different die) so they never stack.
  const old = actor.effects.filter(e => e.name.startsWith("Well Rested Bonus")).map(e => e.id);
  if (old.length) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", old);
    replacedCount++;
  }
  await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  appliedCount++;
}
console.log("Well Rested Bonus applied to:", playerActors.map(a => a.name));
ui.notifications.info(
  `Applied a +${chosenDie} well-rested buff to ${appliedCount} characters`
  + (replacedCount ? ` (replaced an existing one on ${replacedCount})` : "")
  + `: ${playerActors.map(a => a.name).join(", ")}.`
);
