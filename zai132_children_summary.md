## Children complete — QA + Localization delta

### QA ([ZAI-133](/ZAI/issues/ZAI-133)) — 15 PASS / 1 WARN / 0 FAIL

All 4 upstream PRs verified against master commit `4c6c850f`:

| PR | Feature | Result |
|----|---------|--------|
| #5353 | Planning mode toggle + chip | ✅ PASS |
| #5355 | Sidebar polish, CompanyRail removal | ✅ PASS |
| #5292 | Safety / identifier hardening | ✅ PASS |
| #5356 | Workspace thread notices, stale notice | ✅ PASS |
| — | Inbox, Routines, Mobile viewport | ✅ PASS |

**WARN (non-blocking):** `PATCH workMode=planning` returns 409 run-ownership conflict in test context — expected API security behaviour, not a UI bug.  
**Accessibility (pre-existing):** `DialogContent requires a DialogTitle` console gap — not introduced by these PRs.

---

### Localization matrix delta ([ZAI-134](/ZAI/issues/ZAI-134)) — 15 new strings, 6 files

Cross-posted from ZAI-134 (loc agent permission block on cross-agent post).

#### `issues.json` → `row` (2 keys)

| Key | EN | DE |
|-----|----|----|
| `row.planning_mode` | "Planning" | "Planung" |
| `row.planning_mode_title` | "This issue is in planning mode." | "Dieses Ticket befindet sich im Planungsmodus." |

#### `issues.json` → `dialog` (2 keys)

| Key | EN | DE |
|-----|----|----|
| `dialog.work_mode_standard` | "Standard" | "Standard" |
| `dialog.work_mode_planning` | "Planning" | "Planung" |

#### `issues.json` → `chat` (10 keys)

| Key | EN | DE |
|-----|----|----|
| `chat.work_mode_planning_badge` | "Planning" | "Planung" |
| `chat.work_mode_switch_to_standard` | "Switch to standard" | "Zu Standard wechseln" |
| `chat.work_mode_switch_to_planning` | "Switch to planning" | "Zu Planung wechseln" |
| `chat.work_mode_planning_on_tooltip` | "Planning mode is on for this submission. Click to switch to Standard." | "Planungsmodus ist für diese Einreichung aktiv. Klicken, um zu Standard zu wechseln." |
| `chat.no_additional_details` | "No additional details." | "Keine weiteren Details." |
| `chat.stale_disposition_warning` | "Stale disposition warning" | "Warnung: veralteter Dispositionsstatus" |
| `chat.attach_file` | "Attach file" | "Datei anhängen" |
| `chat.more_composer_options` | "More composer options" | "Weitere Optionen" |
| `chat.workspace_change_label` | "Workspace" | "Arbeitsbereich" |
| `chat.workspace_change_text` | "Workspace: {{from}} → {{to}}" | "Arbeitsbereich: {{from}} → {{to}}" |

> **Note:** `chat.workspace_fallback` ("None"/"Keine") can reuse existing `chat.none` key — no new key needed.  
> **Note:** `chat.attach_image` renamed to `chat.attach_file` in #5355 — keep old key aliased until localization branch merges.

#### `common.json` → `sidebar_company` (2 keys — net 1 new)

| Key | EN | DE |
|-----|----|----|
| `sidebar_company.edit_order` | "Edit" | "Bearbeiten" — can reuse `common.actions.edit` |
| `sidebar_company.done_editing_order` | "Done" | "Fertig" |

> **Note:** `sidebar_company.edit_order` can reuse `common.actions.edit` to avoid duplication. `done_editing_order` needs a new key (different context from `common.status.done`).

---

**Matrix delta:** 15 strings proposed (13 net-new keys + 2 reuse candidates).  
Localization implementation will be picked up in the current i18n branch (ZAI-92 chain / `vib-1171-2652-2760-3582-localization`).
