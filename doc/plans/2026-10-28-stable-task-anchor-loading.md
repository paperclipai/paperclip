# Stable task startup and anchors

Deliver one reviewed PR. Keep cold task opens compact for every URL fragment.
Use a disposable local task with a long thread, a saved plan, document cards,
and saved PR cards, modeled on the reported staging page with synthetic text.

| Acceptance | Evidence |
| --- | --- |
| Documents, comments, artifacts and unknown anchors keep compact history | Route tests inspect recent reads and reject full-history reads |
| Older comment links still work | Fetch only the target comment; browser checks target and recent replies |
| Saved cards do not insert after first reveal | Delayed-response browser test records frames, card counts, geometry and video; demonstrate red then green |
| Fast reads remain independent of slow task enrichment | Stall full task detail while opening the local fixture |
| Refresh and More messages preserve mounted content | Browser checks reading position and composer identity |
| Reviewable handoff | Full required checks, token/maps checks, PR template, review and CI |

The task route owns expansion and targeted comment loading. The document service
owns the saved document projection. The thread owns its first coherent reveal.
No anchor may request all comments, full activity, or historical transcripts.
No deployment is included.

Evidence so far: the baseline document/plan cards changed from 0 to 1 to 4
visible cards after reveal, and thread height grew from 690 to 1,432 pixels.
The first candidate keeps all 7 saved cards present and height constant. A
second regression showed delayed PR counts changing card heights from 62 to
82 pixels; reserving that statistics line makes both states 82 pixels.
Final focused UI tests before merge review: 552 pass. Focused server tests: 16 pass. Token and map checks pass.
All nine browser checks, full workspace typecheck and build pass. The full local suite was stopped after about 15 minutes in the serialized server lane; it is not a full local pass. Hosted CI supplies whole-suite acceptance. Review found that document navigation dropped a separately fetched older comment. The fix retains target comments in the observed compact window without advancing its cursor. Its added unit and browser checks pass, including row position. Hosted acceptance is recorded in PR #18092. One early candidate browser run exceeded the initial 5-second dev
readiness deadline; later runs use 10 seconds. No reliable latency gain is claimed.
The initial 503 linked-comment fixture exercised the app's global reconnect and
30-second retry policy. The target-specific failure check uses a terminal 404.

Merge review added regressions for core work products arriving during a pending
stored-list request and malformed comment fragments. Core projections now seed
empty or populated work-product caches without replacing already known lists;
comment fragments must contain UUIDs and API path components are encoded.
The delayed stored-read browser case was red at its 10-second reveal deadline.
Frame evidence also found a 775-to-742-pixel width change after reveal while
the initial properties pane opened. Every first reveal now waits for two stable
width frames, while keeping the existing 15-second fallback. The browser fixture
checks width as well as card positions and heights. Final follow-up verification:
583 focused UI tests and all nine browser journeys pass, along with UI typecheck
and build. The layout capture held seven cards, width 742 and height 1,492 across
101 frames. Review follow-up evidence
and hosted acceptance are recorded in PR #18092.

The next review found the same pending/error distinction for the plan query.
The projection helper now checks for missing plan data rather than a missing
query. Four hook regressions first failed with pending or errored empty caches;
they pass after the fix. The existing-plan test now also preserves a known null.
All 212 affected page/cache/plan-hook tests and UI typecheck pass. CI on c91fa107ba
passed every browser shard, including the earlier YAML clipboard case, but one
unchanged Discord chat-binding test returned false in 185 ms. Its 16-test local
integration file passes unchanged; the CI cause remains unestablished. The next
head's hosted CI must pass before merging.

Local reproduction: http://127.0.0.1:3223/TASAAAAA/issues/TASAAAAA-1#document-investigation.
Synthetic task data only; no live provider execution. Restart with
`PAPERCLIP_HOME=/tmp/paperclip-stable-task-loading PAPERCLIP_INSTANCE_ID=task-loading PAPERCLIP_UI_DEV_MIDDLEWARE=true node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts run`.
Evidence is retained under `/tmp/task-loading-proof/`; the generated report is also attached to the disposable local instance. The canonical PR is https://github.com/paperclipai/paperclip/pull/18092.

State: branch `codex/stable-task-anchor-loading`; baseline `063cfd4381`.
Dependencies installed locally; the existing lockfile was stale and will not be committed.
