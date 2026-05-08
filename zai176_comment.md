## Sweep #6 Results — FAIL

**Branch:** vib-1171-2652-2760-3582-localization  
**Commit verified:** fdfbcbc2  
**Build tested:** port 3101, bundle `index-BTnO0wUZ.js` (last-modified 2026-05-08T04:04 UTC, post-fix)  
**Routes swept:** `/ZAI/dashboard`, `/ZAI/activity`, `/ZAI/agents/all`, `/ZAI/inbox/mine`

---

### Fix 1 — nav.search gaps: PASS (5/5 locales)

"Search" does **not** appear in the sidebar nav for any of the 5 target locales:

| Locale | nav.search rendered |
|--------|---------------------|
| el | Αναζήτηση |
| es | Buscar |
| pt | Pesquisar |
| uk | Пошук |
| zh | 搜索 |

---

### Fix 2 — Board actor hardcoding: FAIL (0/8 locales)

The activity feed still shows **"Board"** (English) for all 8 non-en locales. 25 hardcoded "Board" instances found on `/ZAI/activity` in every locale tested.

| Locale | Activity board actor | Expected |
|--------|---------------------|----------|
| de | Board | Gremium |
| el | Board | Συμβούλιο |
| es | Board | Junta |
| fr | Board | (no activity.json — fallback needed) |
| pt | Board | (no actor.board key) |
| ru | Board | (no actor.board key) |
| uk | Board | (no actor.board key) |
| zh | Board | (no actor.board key) |

For reference: `actor.system` IS translated correctly (Σύστημα, Sistema, Система, 系统), confirming the i18n pipeline works for the system actor path.

---

### Root Cause Analysis

The fix in fdfbcbc2 patched `fallbackUserLabel` in `company-members.ts`:

```ts
if (userId === "local-board") return i18n.t("actor.board", { ns: "activity" });
```

However, `fallbackUserLabel` is only reached when `member.user?.name` is null/empty. The `local-board` principal has `user.name = "Board"` stored in the database. `baseMemberLabel` returns this DB name before reaching `fallbackUserLabel`, so the i18n lookup is never invoked.

In `ActivityRow.tsx` line 52, `userProfile?.label` ("Board" from DB) takes precedence over the `t("actor.board")` fallback. The `t("actor.board")` path is only reached when `userProfile` is null — but `buildCompanyUserProfileMap` always provides a profile for `local-board` with `label: "Board"`.

### What the fix needs to do

Override the label for `local-board` **before** checking `member.user.name` in `baseMemberLabel` (or `buildCompanyUserProfileMap`) in `company-members.ts`:

```ts
function baseMemberLabel(member: …): string {
  if (member.principalId === "local-board") return i18n.t("actor.board", { ns: "activity" });
  const name = member.user?.name?.trim();
  …
}
```

Additionally, `actor.board` translations are only present in de/el/es activity.json. The remaining 5 locales (fr/pt/ru/uk/zh) need `actor.board` added to their activity.json files (note: fr has no activity.json at all).

---

**Overall verdict: FAIL — 1 of 2 fixes passing. Board actor localization requires a deeper fix in `baseMemberLabel` and translation additions for fr/pt/ru/uk/zh.**
