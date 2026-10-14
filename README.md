# Effect Roll Duration

A small Foundry VTT module for the D&D 5e system. It adds a **Rolls** duration to Active Effects: the effect is deleted after its actor makes a set number of d20 rolls.

Requires Foundry v14 and dnd5e 5.3.3 or later (5.x or 6.x).

## Use

1. Open an Active Effect and go to the **Duration** tab.
2. Choose **Rolls** in the duration units dropdown.
3. Enter **Remaining Rolls** (a whole number, 1 or more).

Each time the actor makes a counted roll, every enabled Rolls effect on that actor drops by 1. At 0 the effect is deleted.

## What counts

Counted: attack rolls, saving throws (including concentration saves), ability checks, skill checks, tool checks. Advantage and disadvantage count as one roll.

Not counted: initiative, death saving throws, damage rolls, hit dice.

## Behavior to know about

- **Each effect counts independently.** The counter is stored on the effect itself, so the same effect on several characters counts down separately for each.
- **A GM must be connected.** Rolls are counted by the active GM's client. A roll made while no GM is online is not counted.
- **Disabled or suppressed effects don't count down.** This includes transferred effects from unequipped items.
- **Existing timers still apply.** Choosing Rolls does not clear a timed duration the effect already had. Clear the duration value if you don't want both.
- **Other roll-replacing modules** (for example Midi-QOL) may bypass the hooks this module listens to. Not tested.
- Rerolls are not specially handled and have not been tested.

## How it works

- Count and mode are stored as flags on the effect: `flags.effect-roll-duration.durationMode` and `flags.effect-roll-duration.remainingRolls`.
- Listens to dnd5e's `postRollAttack`, `rollSavingThrow`, `rollAbilityCheck`, `rollSkill` and `rollToolCheck` hooks on the rolling client, which sends the actor to the active GM over a module socket. The GM verifies the sender owns the actor, then decrements.

## Debugging and testing

Enable **Debug logging** in module settings (per user) to log every step with an `[erd]` prefix. In the console:

```js
const erd = game.modules.get("effect-roll-duration").api;
erd.dump("Alice");     // table of an actor's effects and counters
erd.exportLog();       // download the log as JSON
```

[TESTING.md](TESTING.md) is a step-by-step manual test plan that uses these logs as evidence.

## Install for development

Link the folder into your Foundry data directory:

```powershell
New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\FoundryVTT\Data\modules\effect-roll-duration" -Target "C:\src\EffectRollDurationModule"
```
