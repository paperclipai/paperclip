# Antigravity swarm events: what Paperclip can show

Date: 2026-11-24. Evidence:

- Seven recorded swarm turns against `agy acp` 1.5.15, in auto, accept-edits and default modes, including a stop mid-run and a reload. One of them, a 4-helper run with a verifier and the CLI stall monitor, used an isolated `--gemini-dir` exactly like the driver. Its redacted events are the Storybook fixture `ui/storybook/fixtures/antigravity-swarm.sample.json`.
- That run finished in 3 min. The coordinator turn totalled 179,931 tokens; the six helpers used about 123k input and 16k output tokens more. Google shows no price.
- The CLI's built-in skills `native_swarm`, `swarm_pane`, `swarm_narrator` and `swarm_monitor` are unpacked under `<state-dir>/antigravity-cli/builtin/skills/`. They describe what Google's own Swarm UI is built from.
- Stories: Storybook "Design proposals/Patterns/Antigravity swarm activity".

## Short answer

**Partly.** Over ACP Paperclip gets everything the **coordinator** does: the swarm title, each helper's name and brief, its own board posts, a goal/task/thread plan, its text and one usage total. Paperclip gets **nothing the helpers do**. The outputs of `swarm status` and `read_board` are never forwarded: `tool_call_update` arrives with `status: completed` and no `rawOutput` or `content`. All updates carry the one coordinator `sessionId`, and no `session/request_permission` ever arrives for a helper.

The data behind Google's reference UI does exist as **structured files** in the CLI's private `--gemini-dir`. Paperclip already creates and owns that directory per run.

| File | What it holds |
| --- | --- |
| `swarm/board.jsonl` | Every board post: seq, author, time, text, `kind: brief` |
| `swarm/members.json` | The roster: role, `wake_mode` working/waiting, model, killed, read cursor |
| `swarm/plan.json` | Goal, per-helper task, threads |
| `<helper conversation>/logs/transcript.jsonl` | Each helper's tool calls with a `toolSummary`, plus per-step model and token counts |

So nearly the whole reference UI is **derivable** by reading these files. They are undocumented internal files, so a reader must be pinned to the CLI version and tested against fixtures.

**Bug found along the way (real, not fixed here).** The coordinator writes `<state-dir>/antigravity-cli/brain/<session>/.system_generated/swarm/plan.json` with `write_file`, because the `swarm_pane` skill tells it to. The shipped driver's `antigravityOutsideChange` treats that as an outside write and **halts the swarm**. This was confirmed by running `antigravityOutsideChange` from `antigravity-swarm-paths.ts` over the recorded run; it returns the `plan.json` path. This happened in 3 of 7 recorded swarm turns; the other coordinators did not load `swarm_pane`. No current driver code allows this path. Fix: exempt `<state-dir>/antigravity-cli/brain/<this session>/.system_generated/swarm/` and add a red/green test with this transcript.

## Inventory

Legend: **ACP** = AVAILABLE NOW over ACP (structured). **FILES** = DERIVABLE by reading the CLI's private state dir (structured JSON; risk: undocumented, can change with any CLI release). **TEXT** = DERIVABLE by parsing coordinator prose (fragile). **NO** = NOT AVAILABLE.

| Reference UI element | Class | Where exactly | Sample (redacted) | When |
| --- | --- | --- | --- | --- |
| Goal | ACP | User request (Paperclip has it). `swarm{action:"title"}` → `tool_call_update.rawInput.title`. `plan.json` → `write_file` `rawInput.Content` (also a `diff` content block) with `goal.title` and `goal.line`. `session_info_update.title`. | `{"action":"title","title":"Static unit-converter page"}`; `"goal":{"title":"Build tiny static unit-converter web page","line":"Write HTML, CSS, JS, and README, then verify everything."}` | Title in the first ~70 s. Plan right after the adds. The plan is only written when the coordinator loads `swarm_pane` (3 of 7 runs). |
| Member roster + brief | ACP | `tool_call`/`tool_call_update` `name:"swarm"`, `rawInput.action:"add"`, `name`, `brief`, `workspace`, optional `model`. | `{"action":"add","name":"logic-writer","brief":"You own convert.js in the current workspace folder ONLY…","workspace":"inherit"}` | Live, when each helper is added. |
| Member role | ACP (verifier/monitor by name) / FILES | Name convention (`verifier`, `monitor`, `narrator`). `members.json` `role` is only `coordinator`/`worker`. `subagents/<id>.json` `role:"Swarm Worker (css-writer)"`. | `"role":"worker"` | Live. |
| Per-helper task line | ACP when plan is written; else TEXT (first sentence of brief) | `plan.json` `tasks{name: text}` | `"logic-writer":"Write convert.js functions and wiring"` | After the adds. |
| Threads / workstreams | ACP when plan is written | `plan.json` `threads[{id,title,goal,tasks[]}]`. No status or "Now" line: the skill says status comes from the board. | `{"id":"t-verify","title":"Verification and swarm health","tasks":["verifier","monitor"]}` | After the adds. Rewritten if work moves. |
| Member state (working / waiting / killed) | FILES | `members.json` `wake_mode` (`working` while in a turn, `mentions` while asleep on the board), `killed`, `phase`. The coordinator's `swarm status` result has the same data but is **not forwarded** over ACP. | `"logic-writer":{"wake_mode":"working","killed":false}` | Whenever the file is rewritten (seen mid-run). Poll it. |
| Member's current action | FILES (NO over ACP) | `<state-dir>/antigravity-cli/brain/<helper conversation>/.system_generated/logs/transcript.jsonl`: last `PLANNER_RESPONSE.tool_calls[]` (`name`, `args.toolSummary`, path args). | `run_command` · "Verify convert.js syntax, math, and DOM wiring"; `write_file` `<task-folder>/index.html` | Per step, live. Higher risk: the helper transcript format is internal. |
| Board messages (#seq, author, text) | Coordinator's own: ACP. Helpers': FILES (NO over ACP). | ACP: `post_message` `rawInput.text`. The briefs are posted as `@name <brief>`, `kind:"brief"`. FILES: `board.jsonl` `{seq,agent,text,time,kind}`. `read_board{since:N}` / `swarm_wait{since:N}` inputs expose the board's head seq over ACP, but not the messages. | `{"seq":10,"agent":"logic-writer","text":"@verifier [done] convert.js created — defines … kmToMiles … celsiusToFahrenheit"}` | Live in the file. Over ACP only the seq cursor, when the coordinator polls. |
| Task done / In review | FILES (board convention) | A `[done]` post addressed to `@verifier` means "in review". A verifier's `@coordinator [done]` means verified. `[stall]` comes from the monitor. The narrator's `view.json` (`state: review`) would be structured, but the narrator is not added under ACP: the coordinator reported `swarm_narrator` "is not available". | seq 7–10 `@verifier [done] …`, seq 11 `@coordinator [done] Verified all deliverables from #7-#10` | Live in the file. Helpers can misreport (one recorded run: `[done]` after a failed write), so Paperclip's own folder snapshot stays the source of truth for files. |
| Progress ("x of y done · n in review · threads open") | FILES | Computed from `plan.json` tasks/threads + `board.jsonl` `[done]` posts. | 4 of 4 writers in review at seq 10, verified at seq 11 | Live. |
| Helper blocked by the workspace boundary | TEXT (+ FILES) | Not forwarded as a permission request: a helper's prompt times out after 60 s inside the CLI. It reaches Paperclip only as coordinator prose ("permission prompts timed out after 60s waiting for user approval"; this does **not** match the driver's `BLOCKED_TEXT` regex) or in the helper transcript and board. | Helper error: `permission check failed for write_file "<outside>/c.txt" … timed out waiting for user response after 60s` | After a 60 s delay. |
| Verifier result | FILES / TEXT | The verifier's `[done]` post in `board.jsonl`, or the coordinator's final prose. | seq 11 above | Live. |
| Finished | ACP | `session/prompt` result `stopReason:"end_turn"`. The coordinator's `post_message "[done] …"`. In the recorded run, the coordinator was woken inside the **same** prompt; the turn closed 9 s after the verifier's post. | `"[done] Static unit-converter page built and verified (…)"` | End of turn. Helpers stay alive (`SUBAGENT_STATE_ALIVE`, waiting). |
| Stopped (Stop) | ACP | `session/cancel` → prompt result `stopReason:"cancelled"` with usage (the recorded stop). | `{"stopReason":"cancelled","usage":{"totalTokens":29718,…}}` | Immediately (7 ms). |
| Per-member model | FILES | `members.json` `applied_model`/`desired_model`; helper transcript `model`. Not over ACP unless `add` passed `model`. | `"applied_model":"gemini-4-neon-high"` | Live. |
| Usage | ACP (one total) / FILES (per helper) | ACP: `usage_update {used,size}` (coordinator context only) and prompt result `usage` (coordinator total). FILES: helper transcripts carry `input_tokens`/`output_tokens`/`cache_read_tokens` per step, so per-helper usage is derivable. The driver's note "Google does not report it per helper" is true only of ACP. | prompt `usage.totalTokens:179931`; verifier steps sum to 34,265 input / 4,017 output | End of turn (ACP); per step (files). |
| Graph / dependencies | NO (partial FILES) | No dependency graph exists. Only thread grouping (plan) and who-mentions-whom edges from `@name` in `board.jsonl` exist. | — | — |
| Screenshot timeline / reel | NO in practice | `swarm_pane` asks helpers to post `Screenshot: <path> \| caption` for visual work. Not seen in any run. | — | — |
| Narrator Overview (`view.json`: headline, attention, workstreams with state, `now` per member) | NO under ACP | The narrator is only added when `swarm_narrator` is in the coordinator's skill list, and it was not in any ACP run. If Google enabled it, `<state-dir>/brain/<narrator>/swarm_view/view.json` would be the closest match to the reference UI. | — | — |
| `available_commands` | ACP | `available_commands_update` lists `swarm` ("(Preview & Quota Heavy) Run a swarm…") with goal, compact, schedule and others. Useful to detect "swarm not available here". | — | Session start. |

## Practical routes, best first

1. **Read the state-dir files (FILES).** Add a driver-owned watcher on `<state-dir>/antigravity-cli/brain/<session>/.system_generated/swarm/{plan.json,members.json,board.jsonl}`, plus the helpers' `logs/transcript.jsonl` for "current action". Emit normalized Paperclip run events: helper added/state/action, board post, plan. Pin the parser to CLI 1.5.15 fixtures, and fall back to today's ACP-only steps when a file is missing or unparseable. Never read anything else in the dir; it also holds credentials.
2. **ACP-only (today plus plan).** Roster, briefs, plan/threads, coordinator posts, board seq cursor, finish/stop and usage total. No helper state or actions.
3. **Ask the coordinator.** Prompting it to `read_board` does not help, because the result is not forwarded. It could be told to `post_message` summaries, but that costs tokens and is still prose.
