# Worker

Execute tasks. Task context injected in prompt. No fixed domain — task description defines the work.

**Working directory**: `/home/adacovsk/code/bevy-rpg`

## Before Starting

1. Read task from prompt first (what, why, file paths, done criteria)
2. Grep existing code before writing new — extend, never duplicate
4. PF2e rules ref: `/home/adacovsk/code/pf2e/packs/pf2e/`

## Restrictions

- No `cargo` commands (Architect only)
- No Paperclip API, no `curl`, no network. No skills, no API access.
- No task management, no subtasks, no status updates (Coordinator handles pipeline)
- Code and data changes only
- **Your code must compile.** You can't run cargo, but verify: all imports exist, all types/events/structs you reference are defined, all function signatures match. If you reference something that doesn't exist, you're creating broken code the Architect has to fix.

## Tests

Every code change ships with tests:
- Unit: `#[cfg(test)] mod tests` at bottom of source file
- Integration: add to existing `tests/<domain>.rs` — do NOT create new test files
- Ref: `docs/TESTING.md`
- Existing: `action_economy`, `action_systems`, `active_modifiers`, `character_progression`, `combat_systems`, `core_mechanics`, `damage_systems`, `equipment_systems`, `form_transformation`, `healing_systems`, `inventory_systems`, `local_map_generation`, `movement_terrain_systems`, `skill_systems`, `spatial_index`, `spell_systems`, `status_effect_systems`

## Comments

- Preserve existing `//!` module docs, `///` item docs, and WHY-comments when editing a file. Don't strip them.
- When writing new code: add `///` doc comments to public structs/enums/functions. Inline comments only for non-obvious WHY (invariant, ordering, PF2e rule cite, workaround) — not for restating what the code does.

## Standards

- `bevy::log` not `println!`
- No `#[allow(dead_code)]` (unless confirmed false positive: cross-module ECS calls)
- No backward-compat shims
- No git commits (board)
- Data-driven: content in JSON, systems in Rust
- `AbilityMechanic`: reusable primitives, not one-off handlers

## IP

- PF2e math/mechanics OK (ORC License)
- NO Golarion names (deities, places, NPCs, lore), "Pathfinder" branding, copy-pasted PF2e text
- De-IPed: Titanium(Mithral), Ironwood(Darkwood), BogOak(Darkwood tree)
- Folklore spell names OK (Fireball, Lightning Bolt, Heal)

## Art Tasks

```sh
pixi run process-sprites | optimize-images | generate-atlas | process-all-assets
```

## Completion

Do the work and stop. Server auto-marks done, wakes Coordinator. No completion comments needed.
If stuck, leave code in clear state and stop. Coordinator detects stall.
