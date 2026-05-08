## Scope
The Instance Settings → General page (http://127.0.0.1:3105/instance/settings/general) is rendered in Russian locale but most strings are still English. The user specifically asked for ru localization (Eng → Rus). Per project memory `project_localization_round3`, please cover all 8 locales (en, ru, de, es, pt, uk, zh, el) so we do not regress the round-3 8-locale sweep.

## File to wire through i18n
- `ui/src/pages/InstanceGeneralSettings.tsx` — currently has hardcoded English strings. Needs a new namespace (e.g., `instance.settings.general.*`) wired through `useTranslation()` / `t()`.

## Strings observed un-translated on the page (non-exhaustive)

Section headers and labels still in English (line numbers from a quick grep):

- L90: `General` (h1)
- L107: `Deployment and auth`
- L115: `Local trusted mode is optimized for a local operator. Browser requests run as local board context and no sign-in is required.`
- Also: `Local trusted`, `Auth readiness`, `Ready`
- L126: `Bootstrap status`
- L130: `Bootstrap invite`, `None`
- L140: `Censor username in logs` + body copy + `This is off by default.`
- L159: `Keyboard shortcuts` + body copy + `This is off by default.`
- L177: `Backup retention` + body copy
- L186, L215, L245: `Daily`, `Weekly`, `Monthly`
- Preset values: `3 days`, `7 days`, `14 days`, `1 week`, `2 weeks`, `4 weeks`, `1 month`, `3 months`, `6 months`
- L279: `AI feedback sharing` + body copy + `Read our terms of service`
- `No default is saved yet. The next thumbs up or thumbs down choice will ask once and then save the answer here.`
- L305: `Always allow` / `Share voted AI outputs automatically.`
- L310: `Don't allow` / `Keep voted AI outputs local only.`
- The local-dev hint paragraph starting `To retest the first-use prompt in local dev,...`
- L355: `Sign out` (h2)
- L357: `Sign out of this Paperclip instance. You will be redirected to the login page.`
- L367: `Signing out...` / `Sign out`

## Acceptance criteria
1. All visible strings on `/instance/settings/general` resolved through `t()` (no hardcoded English literals in JSX).
2. Translation files updated for all 8 locales: en, ru, de, es, pt, uk, zh, el.
3. Manual sweep in Russian locale shows zero English leaks on this page.
4. No regressions on the page in English locale.
5. Per board memory `feedback_qa_warn_is_fail`: WARN with leakage = FAIL — open the sweep report file and confirm zero leaks before marking done.

## Notes
- Parent issue ZAI-152 is the user-facing report (in Russian). Screenshot only shows `/instance/settings/general` — do not balloon scope to other pages.
- Use the same translation conventions established in ZAI-138/ZAI-139 round 3.
- When done, leave a summary comment on the child and reassign to CEO for review.

## Verification (required before marking done)
- Run a Playwright/QA sweep in `ru` locale across the page.
- Attach the sweep report to this issue.

This issue was opened by CEO on behalf of board issue ZAI-152.
