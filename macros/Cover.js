// Apply Cover
// Select one or more tokens, run this macro, and choose half cover, three-quarters cover,
// or none. It uses dnd5e's built-in cover statuses, so the 2024 rules are handled by the
// system itself: half cover gives +2 to AC and Dexterity saves, three-quarters gives +5.
// Works on Foundry v14 with dnd5e 5.3.3 or later (including 6.x).

const tokens = canvas.tokens.controlled;
if (!tokens.length) {
  ui.notifications.warn("Select a token first.");
  return;
}

// dnd5e status ids (same in 5.3.3 and 6.x). Fail clearly if a future version renames them.
const statuses = CONFIG.DND5E?.statusEffects ?? {};
const COVER_IDS = ["coverHalf", "coverThreeQuarters"];
if (!COVER_IDS.every(id => statuses[id])) {
  ui.notifications.error("This dnd5e version has no cover statuses I recognise. Aborting.");
  return;
}

const bonus = id => statuses[id].coverBonus;
const names = tokens.map(t => t.name).join(", ");

const choice = await foundry.applications.api.DialogV2.prompt({
  window: { title: "Apply Cover" },
  content: `
    <p>Applying to: <strong>${foundry.utils.escapeHTML(names)}</strong></p>
    <div class="form-group">
      <label>Cover:</label>
      <div class="form-fields">
        <select name="cover">
          <option value="none">None (remove cover)</option>
          <option value="coverHalf">Half cover (+${bonus("coverHalf")} AC and Dex saves)</option>
          <option value="coverThreeQuarters">Three-quarters cover (+${bonus("coverThreeQuarters")} AC and Dex saves)</option>
        </select>
      </div>
    </div>`,
  ok: {
    label: "Apply",
    icon: "fa-solid fa-check",
    callback: (event, button) => button.form.elements.cover.value
  },
  rejectClose: false // closing the dialog returns null instead of throwing
});
if (!choice) return;

for (const token of tokens) {
  const actor = token.actor;
  if (!actor) continue;
  // Turn off the other cover status explicitly so two never overlap, then turn on the choice.
  for (const id of COVER_IDS) {
    if (id !== choice) await actor.toggleStatusEffect(id, { active: false });
  }
  if (choice !== "none") await actor.toggleStatusEffect(choice, { active: true });
}

const summary = choice === "none"
  ? `Removed cover from ${names}.`
  : `Applied ${choice === "coverHalf" ? "half" : "three-quarters"} cover to ${names}.`;
ui.notifications.info(summary);
