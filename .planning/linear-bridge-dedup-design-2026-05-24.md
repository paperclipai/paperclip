# Linear ↔ Paperclip bridge enablement: dedup design

**Author:** CEO (Omar) — drafted 2026-05-24
**Status:** Recommendation — awaiting CEO approval
**Tracks:** Blockcast `plugin_company_settings` row pending for `3a020b7a-387b-4571-919f-8d2d2f746651` (paperclip-plugin-linear)

## TL;DR

**Recommend Option D: enable plugin + ship a one-line config flag that disables auto-creates from Linear webhooks + skip bulk /import + use the existing `Link Linear Issue` action for explicit pairing.**

Three of the four "duplicate-prevention risks" called out in the prior handoff were already mitigated in code (verified at `packages/plugins/paperclip-plugin-linear/src/worker.ts`). The remaining risk is **topic-level duplication when Linear issues mirror to Paperclip with no title dedup**. Option D removes that surface entirely while preserving the bridge's actual value (status/comment sync on items the team explicitly wants linked).

## What I verified by reading the plugin code

| Claim from prior handoff | Reality after reading the code | Source |
|---|---|---|
| "Webhook identifier-fallback re-binding can hijack Paperclip-native tickets ≤ BLO-4164" | **False.** The webhook handler never looks up by `BLO-N` identifier; it only matches by Linear's UUID via three layers of dedup: `sync.getLinkByLinear(linearIssueId)`, `ctx.issues.getByLinearIssueId({linearIssueId})`, and `ctx.issues.list({originKind, originId: linearIssueId})`. | `worker.ts:1316, 1372, 1463` |
| "/import creates parallel Paperclip rows with no title dedup" | **True.** Bulk import (`initial-import` job) and webhook `action=create` both unconditionally call `ctx.issues.create({...})` for any Linear issue with no existing link row, getting a fresh `BLO-N` from the Paperclip sequence. There is no title-level dedup against existing Paperclip-native tickets. | `worker.ts:1520, 2196` |
| "Paperclip would re-mint Linear identifiers under identifier_provider='linear'" | **Inapplicable to Blockcast.** Blockcast's `companies.identifier_provider = 'paperclip'` (verified via `kubectl exec paperclip-pg-0 -- psql … SELECT identifier_provider`). The host allocator path only re-mints from Linear when this flag is `linear`, which we have no plans to flip. | `companies` row |
| "Webhook back-and-forth loops created 305 noise issues during 2026-05-03 cutover" | **True but fixed.** The `inFlightCreates` set + `ctx.issues.getByLinearIssueId` host-side dedup added after that incident is now in place. | `worker.ts:1398-1402, 1372-1396` |

## Real residual risk

**Topic-level duplication: every Linear issue becomes a NEW Paperclip row** (with a fresh BLO sequence number — Blockcast Paperclip is at BLO-6979 as of this writing; new Linear-originated rows would land at BLO-6980+). If the team has already created a Paperclip-native ticket about the same topic, you get two rows with the same title and no automatic merge.

This is the "BLO numbers diverge by ~720" pattern referenced in `linear-blockcast-conventions.md` memory. It doesn't break anything — it just creates user confusion.

## Options compared

| | A: Enable + accept duplicates | B: Direction-only (paperclip → linear) | C: Manual-only / no auto-create | **D: Recommended** |
|---|---|---|---|---|
| Enable `plugin_company_settings` | Yes | Yes | Yes | Yes |
| Run bulk `/import` | Yes | No | No | No |
| Webhook auto-creates on new Linear issue | Yes | n/a (no inbound) | Yes (devolves to A) | **No — guarded by `disableLinearOriginatedCreates` flag** |
| Webhook update/comment sync on linked rows | Yes | n/a | Yes | Yes |
| Manual `Link Linear Issue` action | Available | Available but useless | Required | **Required** |
| Duplicate rows on existing topics | Many | Zero | None new (but no surface either) | Zero |
| Time-to-enable | Hours | Hours | Hours | **~30 min** (one config-key add to plugin) |
| Code change needed | None | Set `syncDirection: "paperclip-to-linear"` on inserts | None (but no value either) | **Add one config flag check in `handleWebhookEvent`** |
| Cleanup work | One-time title-dedup script | None | None | None |
| Recovery if wrong call | Hard — rows are minted | n/a | n/a | Easy — flip flag off, manually link the next batch |

## Recommended path (Option D) — implementation outline

### Code change (paperclip-plugin-linear)

```ts
// packages/plugins/paperclip-plugin-linear/src/manifest.ts
// Add to configSchema:
disableLinearOriginatedCreates: {
  type: "boolean",
  default: true,
  description:
    "When true, webhooks for Linear-side issue creation do NOT auto-mirror " +
    "to Paperclip. Use the 'Link Linear Issue' action to pair items explicitly. " +
    "Set to false to revert to bulk auto-mirror behavior.",
},

// packages/plugins/paperclip-plugin-linear/src/worker.ts
// In handleWebhookEvent, before the action === "create" branch (~line 1351):
} else if (action === "create") {
  const config = await ctx.config.get();
  if (config.disableLinearOriginatedCreates !== false) {
    ctx.logger.info(
      `Skipping Linear issue.create webhook for ${data.identifier ?? linearIssueId} ` +
      `(disableLinearOriginatedCreates=true; use 'Link Linear Issue' action for explicit pair)`,
    );
    return;
  }
  // … existing handler body unchanged
}
```

Tests:
- Webhook `action=create` with flag default-true → no Paperclip create, no link row written.
- Webhook `action=create` with flag explicitly false → existing behavior preserved (covered by existing tests).
- Webhook `action=update` on a pre-linked issue → still syncs regardless of flag.
- Webhook `action=comment` on a pre-linked issue → still syncs regardless of flag.

### Configuration (Blockcast `plugin_company_settings`)

```json
{
  "linearTeamId": "0241f28e-e546-48d9-a1a2-c1655adf9ba4",
  "linearTokenRef": "<secret-name>",
  "linearWebhookSigningSecret": "<from-linear-app-settings>",
  "disableLinearOriginatedCreates": true,
  "defaultProjectId": "<paperclip-project-uuid-or-null>"
}
```

### Enablement order

1. Land the plugin code change (own PR, separate from BLO-6979). Tag the BLO ticket.
2. Insert `plugin_company_settings` row for Blockcast with the flag ON.
3. Register the Linear webhook URL at Linear's app settings page.
4. Smoke test: create a test Linear issue → confirm no Paperclip row appears.
5. Run `Link Linear Issue` on one real ticket → confirm the link row writes + first comment/status sync round-trip works.
6. Roll out to the rest of the team for explicit linking.

### What this gives up

- No "bulk visibility" of Linear's backlog inside Paperclip. AI agents only see Linear tickets that have been explicitly linked.
- That's actually fine for now — agents are bottlenecked by Paperclip-native work; the bridge's first job is to support the 2-3 cross-system tickets per week the team actually pairs.

### What this preserves

- Comments sync bidirectionally on linked items (the actual workflow we care about).
- Status changes sync bidirectionally on linked items.
- Paperclip-to-Linear webhook (issue created in Paperclip → mirror to Linear) — that path is gated on `linkedLinearIssue` in `ctx.issues.create`, not the flag.

## Open questions for CEO

1. **`paperclip-to-linear` direction for NEW Paperclip-native issues**: should newly-created Paperclip issues (originKind=manual, not from a Linear webhook) AUTOMATICALLY mirror to Linear? The current plugin's `issue.created` event handler does this when the plugin is enabled. If we want **only Linear→Paperclip linking by explicit action** AND **no auto-mirror in either direction**, we need a second flag (`disablePaperclipOriginatedMirrors`) wired into that handler. Recommend: **yes, add this too**, for symmetry.
2. **Existing Paperclip-native ticket overlap**: even with Option D, when an operator runs `Link Linear Issue` they need to know which Paperclip ticket to pair. Should we surface a "linkable candidates" search by title fuzzy-match in the CLI/UI? That's a separate UX project; for now operators paste the Paperclip issue ID manually.
3. **Webhook signing secret rotation**: Linear's webhook signing secret is in `plugin_company_settings.linearWebhookSigningSecret`. We should plan a periodic rotation (quarterly?). Out of scope for this design — file a separate ticket.

## Resources

- Plugin source: `packages/plugins/paperclip-plugin-linear/src/`
- Schema: `packages/db/src/schema/linear_issue_links.ts`
- Existing manual-link action: `worker.ts:860` (`Link Linear Issue`)
- Prior incident: 2026-05-03 cutover, 305 noise Linear issues — fixed by `inFlightCreates` + `ctx.issues.getByLinearIssueId` host-side dedup
