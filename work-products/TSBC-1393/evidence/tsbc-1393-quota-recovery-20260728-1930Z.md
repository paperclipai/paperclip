# TSBC-1393 quota recovery evidence - 2026-07-28 19:30Z

Wake payload had 0 new comments and pointed to the 2026-07-28 monitor recovery for TSBC-1393.

## Diagnosis

- The launchd drill was alive, but the AGY path was hammering an exhausted provider quota after the reset moved from hours to multiple days.
- Direct neutral-cwd AGY probe returned JSON status `ERROR` with `Individual quota reached` and `Resets in 95h19m49s`.
- The harness misclassified that JSON error as `agy self-report: unparseable output (rc=1)`, so the AGY backlog loop reran `engineer` repeatedly instead of taking the quota halt path.

## Changes

- `/Users/glad0s/paperclip/benchmark/adapters.py`: AGY self-report now surfaces JSON `error` / `status` fields, allowing quota errors to set `quotaError`.
- `/Users/glad0s/paperclip/benchmark/bench.py`: the first cells that trigger an adapter quota halt are marked `skipped` with `antigravity_quota_halt`, matching later cells in the same run.
- `/Users/glad0s/paperclip/benchmark/tsbc-drill.sh`: AGY quota sleep cap increased from 6 hours to 7 days so multi-day resets are honored.

## Live service state

- `launchctl kickstart -k gui/501/com.thinkstack.tsbc-drill` restarted the drill after the patch.
- New service PID: `41388`.
- Fresh run after restart: `/Users/glad0s/paperclip/benchmark/results/run-20260728-202807/`.
- Fresh drill log ended with: `AGY quota halt detected - sleeping 343402s before retry`.
- Estimated retry target from that sleep: `2026-08-01T18:52:34Z` (local: 2026-08-01 19:52 IST/BST).

## Verification

- `/Library/Frameworks/Python.framework/Versions/3.14/bin/python3 -m py_compile /Users/glad0s/paperclip/benchmark/bench.py /Users/glad0s/paperclip/benchmark/adapters.py`
- `bash -n /Users/glad0s/paperclip/benchmark/tsbc-drill.sh`
- Synthetic no-quota-spend adapter probe confirmed `quota=true` for the AGY JSON quota payload.

## Paperclip artifact gate

- Existing attachment `13f692c1-9ded-4b38-9f97-055aadea4ea0`: `TSBC-1393-report.pdf`.
- Existing attachment `97f0a774-c9cd-413f-88a8-92e647f01e22`: `TSBC-1393-report.md`.

## Disposition

Blocked. The local harness is repaired and sleeping on the provider's stated AGY quota reset; the remaining matrix cannot produce new answer rows until AGY quota is restored or the reset time passes.
