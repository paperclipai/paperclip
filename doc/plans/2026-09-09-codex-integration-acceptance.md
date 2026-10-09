# Codex integration acceptance — 2026-09-09

## Environment and scope

All live tests used the pinned Codex CLI 0.153.4 and gpt-5.6-sol.
Each fixture used an isolated Codex home. A repository contained known launch
notes, a configuration marker, a skill marker, and a harmless SessionStart hook.
The hook only appended a line to a fixture file.

Streaming and feed-display changes remain separate pull requests. These tests
used their combined implementation checkout. Each PR is also checked on the
current master before merge.

## Native browser acceptance

A fresh test-drive instance started without tasks or prior runs. The test agent
used paperclip_runner with Codex. Browser actions created a task in the fixture
project, requested the notes, and sent two follow-up messages. The test server
was restarted between the first answer and the follow-ups.

All three native runs succeeded. They returned the expected notes and markers,
then answered a date-change question and recalled the original reference.
Answers persisted after refresh. No provider notice appeared. The task composer
remained usable.

The task policy opened new provider threads for completed-task follow-ups.
This browser test does not prove same-thread resume. The next tests do.

## Same-thread local driver acceptance

The production TypeScript driver ran an initial repository read, a follow-up,
a provider shutdown, persisted-session recovery, and a second follow-up.
All answers used the same provider thread and retained the required context.

- No provider notices appeared.
- Configuration and skill markers loaded.
- The approved hook ran once at startup and once at cold resume.
- Run usage was 40,445 + 13,624 + 10,538 = 64,607 tokens.
- The sum equaled the final cumulative session usage. Historical usage was
  not charged again.
- Resume usage produced only the bounded local diagnostic.

## Daytona driver acceptance

A disposable Daytona sandbox ran the production TypeScript driver bundle.
The test installed Codex 0.153.4 because the image had an older version.
Startup, warm follow-up, process shutdown, cold resume, and the second
follow-up all succeeded on the same provider thread.

- Configuration and skill markers loaded.
- The approved hook ran once at startup and once at cold resume.
- No trust, history-deprecation, or settled-turn usage warning appeared.
- Run usage was 23,006 + 11,611 + 8,120 = 42,737 tokens.
- The sum equaled the final cumulative session usage.
- A separate warning about missing system bubblewrap remained visible.
  Codex used its bundled copy. The change does not suppress that warning.

The sandbox was deleted after evidence collection. Remote Paperclip UI and
remote Rust execution were not tested.

## Hook trust and experience limits

Codex reviews hook hashes separately from repository trust. The test queried
hooks/list and approved only the harmless fixture hash through config/batchWrite.
Product code does not bypass this policy or copy operator configuration.

The task feed worked correctly. Two separate issues remain outside this change:
a dashboard preview could retain old running text, and test-drive restart could
use a different database when its saved port did not match its actual port.
The fixture configuration was corrected before sending further messages.
Existing test data was preserved. Transitions were sampled rather than filmed.

## Automated verification before PR preparation

- Codex/native-transport TypeScript: 333 passed.
- Adjacent OpenCode/ACPX driver, accounting, and recovery tests: 49 passed.
- Same-run attach and usage baseline regression: 4 passed.
- Rust library, serialized: 226 passed.
- Rust Codex integration: 72 passed, 1 ignored; two new pagination tests passed.
- Production native server integration passed after rebuilding its stale fake
  provider. The test now asks Cargo to check binary freshness.
- Repository typecheck and build passed.
- Repository test groups have passing coverage after environment retests.
  General-server coverage was 7,217 passed and 30 skipped. Route coverage was
  2,175 passed and 4 skipped across 144 files.

The initial monolithic test command did not pass cleanly. Parallel test loads
caused timeouts; isolated reruns passed. CLI database tests reached the macOS
shared-memory limit; they passed after unused disposable fixture servers were
stopped. No production behavior or timeout setting changed for those failures.
The default parallel Rust library run also had Claude fixture transport failures;
the complete serialized rerun passed. PR checks record validation after replaying
these changes onto current master.
