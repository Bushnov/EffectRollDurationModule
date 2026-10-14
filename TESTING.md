# Manual test plan: Effect Roll Duration

No framework in this repo runs Foundry automatically (Quench exists as an in-Foundry test runner, but it still needs a live world). So testing is manual, but every step produces log evidence: the module logs each decision with an `[erd]` prefix and can export the log as JSON.

## Coverage matrix

Every behavior in [scripts/main.js](scripts/main.js) maps to at least one test. If you add behavior, add a row.

| Behavior | Code | Tests |
|---|---|---|
| Module loads, settings registered, API exposed | `init`, `ready` | T0 |
| "Rolls" option injected into core units select | `renderActiveEffectConfig` (core-select path) | T1 |
| Count field shows/hides; flags saved; core `duration.units` unchanged; odd count values | same | T1, T2 |
| State persists across sheet reopen and reload | flags | T1, T15 |
| Attack rolls counted | `postRollAttack` | T3a |
| Saving throws counted (incl. concentration, once) | `rollSavingThrow` | T3b, T3f |
| Ability checks counted | `rollAbilityCheck` | T3c |
| Skill checks counted | `rollSkill` | T3d |
| Tool checks counted | `rollToolCheck` | T3e |
| Initiative, death saves, damage, hit dice NOT counted | (no hook) | T4 |
| Advantage/disadvantage counts once; cancelled dialog counts zero | hooks fire per roll action | T5 |
| Decrement by 1; delete at 0; count of 1 deletes on first roll | `decrementEffects` | T6 |
| Disabled effects skipped; non-Rolls effects untouched; several effects on one actor | `decrementEffects` | T7 |
| Item-transferred effects counted | `allApplicableEffects` | T8 |
| Independent counters across actors (copied effect, shared item, unlinked tokens) | per-document flags, `fromUuid` | T9 |
| GM roll handled locally | `report` local branch | T10 |
| Player roll relayed to GM via socket | `report` socket branch, socket receiver | T11 |
| Roll dropped when no GM online | `report` no-GM branch | T12 |
| Non-owner socket message rejected | ownership check | T13 |
| Rapid rolls do not lose or double count | `queueDecrement` | T14 |

**What this cannot prove.** Manual runs show the behavior in your setup (one dnd5e/Foundry version, a few clients). They cannot prove freedom from rare races (two GMs connected, a GM disconnecting mid-roll) or other modules interfering. T14 and T12 probe the likeliest of these. Re-run the full list after any Foundry or dnd5e update.

## Setup

1. Install the module. Link this folder into Foundry's data folder (adjust the path to your install; this does not copy files, so edits show after a reload):
   ```powershell
   New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\FoundryVTT\Data\modules\effect-roll-duration" -Target "C:\src\EffectRollDurationModule"
   ```
2. Create a **new test world**: system dnd5e 6.x, Foundry 14.367 or later. Enable this module.
3. Create actors **Alice** and **Bob** (player-owned, linked) and **Goblin** (NPC, owned by nobody). Create users **GM**, **PlayerA** (owns Alice) and **PlayerB** (owns Bob).
4. Open two sessions: the GM in one browser, PlayerA in another browser or a private window. Open the console (F12) in both.
5. In each session: Settings, Configure Settings, Module Settings, tick **Debug logging**, save, reload. Debug logging is per user, so enable it for each user you test with.
6. Give Alice a weapon with an attack, and make sure she has at least one skill, one tool and one saving throw to roll.

## How to collect evidence

- Watch the console with filter `[erd]`.
- Before each test: `game.modules.get("effect-roll-duration").api.logBuffer.length = 0` (clears the log, so each test's log stands alone).
- After each test: `game.modules.get("effect-roll-duration").api.dump("Alice")` prints a table of Alice's effects with their counters, and `...api.exportLog()` downloads the log as `erd-log-<user>-<time>.json`.
- Record each test as: ID, pass/fail, the dump table, and the log file name. Saving the exported logs is the evidence.

Shorthand used below: `erd = game.modules.get("effect-roll-duration").api`

Helper to create a Rolls effect from the console (GM), so you don't need the sheet each time:
```js
await (game.actors.getName("Alice")).createEmbeddedDocuments("ActiveEffect", [{
  name: "Test Rolls", img: "icons/svg/aura.svg",
  flags: { "effect-roll-duration": { durationMode: "rolls", remainingRolls: 3 } }
}]);
```
This bypasses the sheet. Only T1 and T2 test the sheet itself.

---

## T0. Load and logging

1. Reload the GM session with debug on.
2. **Expect** a log `ready` with `foundry`, `system: "dnd5e 6.x"`, your `activeGM`, and `registeredExpiryEvents: []`.
3. Run `erd` in the console: **Expect** an object with `dump`, `exportLog`, `simulateRoll`, `logBuffer` (not `undefined`).
4. Run `erd.dump("Alice")`: **Expect** a table (empty is fine).

**Fail if** `game.modules.get("effect-roll-duration").api` is undefined or no `ready` log appears.

## T1. Sheet UI (the "Rolls" dropdown)

1. As GM, open Alice, Effects tab, create an effect, open it, go to the Duration tab.
2. Look at the log `sheet:render` and `sheet:injected`.
   - **Expect** a `sheet:injected` entry. The `sheet:render` entry lists the real `selects`, `parts` and `tabs`. **Keep this entry; it settles the unverified sheet markup.**
   - If the console warns "duration units select not found", the Rolls option was not added: send me the `sheet:render` entry.
3. Open the units dropdown. **Expect** the normal units plus "Rolls".
4. Choose "Rolls". **Expect** the "Remaining Rolls" field appears and a log `sheet:units-changed` with `selectHasName: false, mode: "rolls"`.
5. Set Remaining Rolls to 3. Close the sheet (changes save on change in dnd5e; use the save button if there is one).
6. Run `erd.dump("Alice")`. **Expect** `mode: "rolls"`, `remaining: 3`, and `units` unchanged from before (not "rolls").
7. Reopen the sheet. **Expect** "Rolls" selected, field shows 3.
8. Switch the dropdown back to a normal unit. **Expect** the field hides and log `mode: "none"`. Save; `erd.dump` shows `mode: "none"`.
9. Switch to Rolls again, save, and confirm no validation error notification appeared in Foundry.

**Fail if** a validation error appears on save, the units value changes to something invalid, or the state is lost on reopen.

## T2. Sheet save errors (negative check)

1. With "Rolls" selected, set Remaining Rolls to 0, then to a negative number, then to a decimal.
2. Close and run `erd.dump("Alice")`.
3. **Expect** (after the fix) the stored value is a whole number >= 1: 0 and negatives become 1, 1.5 becomes 2. The first run stored 1.5 as typed.

## T3. Each roll type counts once

For each, create the helper effect on Alice with `remainingRolls: 5`, clear the log, roll, then dump.

| ID | Roll (as PlayerA, Alice's sheet) | Expected hook in log |
|---|---|---|
| T3a | Weapon attack roll (use the activity's attack button) | `hook:fired` `postRollAttack` |
| T3b | Saving throw (any ability) | `rollSavingThrow` |
| T3c | Ability check (any ability) | `rollAbilityCheck` |
| T3d | Skill check | `rollSkill` |
| T3e | Tool check | `rollToolCheck` |
| T3f | Concentration save (give Alice concentration, or use the sheet's concentration roll) | **one** `rollSavingThrow` only |

**Expect for each:** exactly one `hook:fired`, then `report:socket-emit`, then on the GM client `socket:received`, `decrement:start`, `decrement:update` with `before: 5, after: 4`. The dump shows `remaining: 4`.

**Fail if** the counter drops by 2 (double count, most likely on T3a or T3f), or stays at 5.

## T4. Rolls that must NOT count

With a Rolls effect (5) on Alice, clear the log, then do each, and dump after each:

1. Roll initiative (in a combat, or from the sheet).
2. Make a death saving throw.
3. Roll a damage roll from a weapon.
4. Roll a hit die (short rest dialog).

**Expect** no `hook:fired` and no counter change. The death save now logs `hook:ignored` with `reason: "death save"` (first run: it counted, because death saves fire the saving throw hook). Record the `saveType` and `messageType` values in that log entry. If a `hook:fired` appears for any of these, record it; it means the hook set is wrong.

## T5. Advantage and cancelled rolls

1. Effect at 5. Roll a skill check with **advantage** (two dice). **Expect** one `hook:fired`, counter 4.
2. Roll with disadvantage. **Expect** counter 3 (one count).
3. Open a roll dialog and **close it without rolling**. **Expect** no log, counter still 3.

## T6. Countdown and deletion

1. Effect with `remainingRolls: 2`. Roll twice.
2. **Expect** first roll: `decrement:update before 2 after 1`. Second: `decrement:delete`, and the effect disappears from Alice.
3. Create another with `remainingRolls: 1`. One roll deletes it (`decrement:delete before: 1`).
4. Roll again with no effects. **Expect** `decrement:none`.

## T7. Selection rules on one actor

On Alice create: **A** Rolls (3), **B** Rolls (3) disabled, **C** a normal effect with no Rolls mode, **D** Rolls (1).

1. Clear log, make one roll.
2. **Expect** A to 2, D deleted, B untouched (`decrement:skip-disabled`), C untouched.
3. Re-enable B and roll: B to 2.

## T8. Item-transferred effects

1. Give Alice an item with a transferred effect (Transfer to Actor on) set to Rolls, count 3.
2. Roll once. **Expect** the effect's counter drops to 2 (the dump lists it from `allApplicableEffects`).
3. Let the count reach 0. **Expect** the effect is deleted from the item without errors. Note what happens to the item itself (it stays).

## T9. Independence across actors

1. **Copied effect.** Create a Rolls (3) effect on Alice, drag it onto Bob. Roll once as Alice. **Expect** Alice 2, Bob 3. Roll twice as Bob. **Expect** Alice 2, Bob 1.
2. **Shared source item.** (UI labels are from memory of dnd5e; adjust if 6.x differs.)
   1. Create an item (a Feature or Spell). On its **Effects** tab add an effect with "transfer to actor" **off**; in its Duration tab choose **Rolls** and set the count to 3.
   2. On the item's **Activities** tab add an activity (Utility is simplest). In that activity's **Effect** tab, add the effect so it is offered on use.
   3. Drag the item onto an actor (for example Goblin); an item can only be used from an actor.
   4. Target Alice, Bob and Goblin (select a token, press T, Shift-click for several) and use the item. On the chat card, click the effect's apply button.
   5. Run `erd.dump("Alice")`, `erd.dump("Bob")` and `erd.dump("Goblin")`. **Expect** each to have its own copy with `mode: "rolls"` and `remaining: 3`. If a copy shows `(unset)`, the Rolls flags were lost when applying from an item: record it as a FAIL.
   6. Roll as Alice only. **Expect** only Alice's copy drops to 2; Bob's and Goblin's stay at 3.
   - Fallback if the card flow fails (same copy operation, no item UI):
     ```js
     const src = game.actors.getName("Alice").effects.find(e => e.name === "Test Rolls");
     for (const n of ["Bob", "Goblin"]) {
       await game.actors.getName(n).createEmbeddedDocuments("ActiveEffect", [src.toObject()]);
     }
     ```
3. **Unlinked tokens.** Place two unlinked Goblin tokens with a Rolls (3) effect each (set via the token's actor). Roll as one. **Expect** only that token's effect changes (the `actor` in the log is a `Scene.…Token.…Actor` UUID).
4. **Parallel.** Roll Alice and Bob back to back from two sessions. **Expect** each logs its own `decrement:start` with its own actor.

**Fail if** any other actor's counter moves.

## T10. GM rolls locally

1. As GM, roll a check for Alice from the GM's session.
2. **Expect** `report:local` (no socket) and a decrement.

## T11. Player rolls relay through the socket

Covered by T3 (PlayerA rolls). Additionally check in the **GM's** log `socket:received` with `senderId` equal to PlayerA's user id, and in PlayerA's log `report:socket-emit` with `to: "<GM name>"`.

Also run, as PlayerA, with no dice: `erd.simulateRoll("Alice")`. **Expect** the same chain and one decrement.

## T12. No GM online

1. Log out the GM session. Keep PlayerA.
2. In PlayerA's session roll a skill check for Alice.
3. **Expect** `report:dropped` with `reason: "no active GM"`. Log the GM back in and `erd.dump("Alice")`: counter unchanged.

## T13. Ownership check

1. As PlayerA (owns Alice, not Bob) with a Rolls effect on Bob, run:
   ```js
   game.socket.emit("module.effect-roll-duration", { actorUuid: game.actors.getName("Bob").uuid })
   ```
2. **Expect** on the GM log: `socket:received`, then `socket:rejected` with `reason: "sender does not own actor"`, and Bob's counter unchanged.
3. Repeat with `{ actorUuid: "Actor.doesNotExist" }`. **Expect** `socket:rejected`, no error thrown.

## T14. Rapid rolls

1. Effect at 10 on Alice. As GM run:
   ```js
   const a = game.actors.getName("Alice");
   for (let i = 0; i < 5; i++) a.rollSkill({ skill: "acr" }, { configure: false });
   ```
2. **Expect** 5 `hook:fired`, 5 `decrement:update` in strict order (`before: 10 after 9` ... `before: 6 after 5`), and a final counter of 5.
3. Repeat from PlayerA's console to exercise the socket path.

**Fail if** the sequence repeats a `before` value (a lost update).

## T15. Persistence

1. Effect at 4, roll once (3). Reload the GM and player sessions. `erd.dump("Alice")`: **Expect** 3.
2. Roll again after the reload. **Expect** 2.

---

## Result template

```
ID:     T3b
Result: PASS / FAIL
Dump:   (paste erd.dump table)
Log:    erd-log-GM-1760000000000.json, erd-log-PlayerA-1760000001234.json
Notes:
```

Send me any FAIL together with the exported logs and the `sheet:render` entry from T1, and I can fix from that.
