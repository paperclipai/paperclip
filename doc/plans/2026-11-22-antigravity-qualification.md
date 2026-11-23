# Google Antigravity: from pending candidate to qualified harness — 2026-11-22

Continues [the October integration plan](2026-10-28-antigravity-integration.md).
That document remains the historical ledger for the macOS candidate. This one
is the current release contract and acceptance ledger.

## Release contract

| Decision | Answer |
| --- | --- |
| User outcome | An operator picks Google Antigravity, binds a Google credential, picks a model (including Gemini 4 Neon at any offered thinking level) and assigns ordinary work, locally or in a cloud sandbox. |
| Native route | Google's official Antigravity ACP server through the existing ACPX driver. |
| Runtime pin | ACP server **1.5.2** (registry commit `e29b5bf3bf`, 2026-11-21), two-executable closure, owned admission patch re-ported. |
| Platforms | Target: linux-x64 (Daytona) and darwin-arm64 (local), both verified and started natively, neither yet live-qualified (see ledger). linux-arm64: static verification only, never started. darwin-x64: inventory-only (no native host). |
| Authentication | `gemini-api-key` (local and remote) and personal Google sign-in (local). Agent Platform (Vertex/ADC) and remote OAuth: see open decisions. |
| Models | Caller-selected, read from the account or server catalog. No product allowlist. Thinking level is part of the model ID (`<family>-<level>`, levels `minimal/low/medium/high/extra_high`). |
| Release target | One reviewable PR with green checks; merge and production flip are separate decisions. |
| Deployment policy | Unchanged: `PAPERCLIP_AVAILABLE_HARNESSES` stays the deployment's choice. |

## Verified upstream facts (2026-11-22)

- Registry is at 1.5.2; all four archive checksums match the registry.
- Linux `.par` is an ELF launcher with a Python 3.14 zip appended. macOS `.par`
  is a signed Mach-O. The helper `localharness_external` is unchanged in role.
- In 1.5.2 a bare `GEMINI_API_KEY` no longer selects an auth method; `auth.type`
  in settings or an `authenticate` call is required.
- **All four `gemini-4-*` families are marked `agent_platform_only` in the
  server's built-in catalog.** In `gemini-api-key` mode the server lists only
  the Flash families and 3.1 Pro. Google's "Neon with API keys" note (Nov 20) is
  for the Antigravity App, not this ACP release.
- The Gemini Developer API lists `gemini-4-neon` for our test key, but the key is
  free tier with a Neon quota of 0.
- Patch `1.5.2-paperclip.2` adds exact-model admission, so a requested API-key
  model ID (Gemini 4 and Neon included) is admitted with an exact receipt despite
  the built-in `agent_platform_only` marking. Inference is a separate question.
- The ACP layer exposes no Orchestrator mode.

## Routes to Neon

State as of the end of 2026-11-22. "Admitted" means the patched server returned
an exact-model receipt for the requested ID without sending a prompt; it is not
evidence that Google serves inference for that model on that credential.

| Route | State | Needs |
| --- | --- | --- |
| API key (exact-model admission in patch `1.5.2-paperclip.2`) | All four Neon levels admitted prompt-free with exact receipts on macOS and Linux x64; no `AGY_ACP_DEFAULT_MODEL` needed. No Neon prompt has completed: the only key is free tier (Neon quota 0) | A paid Gemini key, then one accepted prompt per level |
| Personal Google sign-in (subscription catalog) | Local macOS sign-in journey proven on 1.4.3 (October); not re-run on 1.5.2; never offered in a cloud sandbox | An entitled account and the attended sign-in journey on 1.5.2 |
| Agent Platform (Vertex/ADC) | Advertised by the server, never exercised here | A Google Cloud project and service credentials |

## Workstreams

1. **Runtime 1.5.2 and cross-platform closure.** Bump the pin; port the patch to
   1.5.2 on Mach-O and ELF; per-platform helper identity; four-platform
   distribution declaration; version checks; regenerate profiles; widen the
   platform gates in the runner, Rust and the sidecar schema. Proof: clean
   provisioning plus native initialize, API-key authenticate and one Flash prompt
   on darwin-arm64 and linux-x64.
2. **Test catalog and CI.** Antigravity API-key profile, a qualification suite on
   the Kimi pattern (local and Daytona), stop/lifecycle/provider-death cases, CI
   matrix wiring for `GEMINI_API_KEY`, unit coverage of the catalog.
3. **API-key connection and models.** Model discovery for API-key connections,
   Neon and thinking-level projection, model audit, Neon route chosen above.
4. **Remote execution.** Provider pack and Daytona image carry the Linux
   closure; lift the executor's remote/warm gates for the API-key route; remote
   credential home.
5. **Lifecycle gates.** Loaded-session admission, Stop, questions and
   permissions, durable recovery (today it throws), provider-death expiry.
6. **Qualification flip and review.** Flip the four pending declarations on the
   Kimi template, update UI/CLI/docs/maps, run the acceptance matrix and the
   existing evals under the native Runner, record results here.

Order: 1 and 2 in parallel; then 3, 4 and 5; then 6.

## Acceptance ledger

Profile state: **pending**. The qualification flip has not happened and must
not happen until every row marked NOT RUN below has passed live.

**No prompt has completed on 1.5.2 on any platform.** The only Gemini key
available is free tier; Google answered every prompt attempt on two days with
503 (overloaded) or 429 (`RESOURCE_EXHAUSTED`). Everything below that needs a
model to answer is therefore NOT RUN, not failed and not passed.

| Gate | Required observation | Verdict (2026-11-22) |
| --- | --- | --- |
| Runtime pin | ACP server 1.5.2 with owned patch `1.5.2-paperclip.2`, closures re-pinned | Done |
| Distribution | Clean setup verifies vendor and patched closures on each claimed platform; tamper rejected | darwin-arm64: verified and started natively. linux-x64: provisioned and started natively in Daytona. linux-arm64: static verification only, never started. darwin-x64: not supported |
| Remote provider pack | Pack carries the Linux closure; server's remote path verifies it | Passed for linux-x64 through the server's remote path in Daytona. Re-verification on a reused sandbox lease 4.3 s → ~0.25 s |
| API-key auth | Native `gemini-api-key` session reaches an exact-model receipt | Passed live on macOS and Linux x64 (receipt only; no prompt) |
| Model admission | Every model ID admitted by exact-model admission, prompt-free | Passed: all 28 IDs (14 Gemini 3, 14 Gemini 4 including Neon at four levels) get exact receipts under an API key on both platforms, without `AGY_ACP_DEFAULT_MODEL` |
| Kill and resume | Native process killed between turns; a new process resumes the session | Passed prompt-free on macOS and Linux x64 with exact receipts. Not yet shown with a completed prompt, and no live `session/load` was observed |
| Launch cost | Run start to native initialize | Sealed verified store: 1.46 s (macOS) / 1.74 s (Linux x64), from 3.45 / 3.65 s. Measured before the launcher regained its streamed executable hash (below); that hash measured ~60 ms for the 179 MB macOS server and is not yet re-measured for the ~722 MB Linux launcher |
| Model lineup inference | Per model/level: one accepted prompt | NOT RUN (no prompt completes on the free key) |
| Neon inference | Real task on `gemini-4-neon-*`, each level acknowledged | NOT RUN (free-tier Neon quota is 0) |
| Ordinary task | File bytes, artifact, accepted result, Done after reload, local and Daytona | NOT RUN on 1.5.2 (local macOS passed on 1.4.3 in October) |
| Scoped tools | Semantic and MCP round trip; wrong-company and stale authority denied | NOT RUN |
| Questions and permissions | Native identity, one continuation, denial holds | NOT RUN |
| Stop and lifecycle | Stop during a tool call, pending-input Stop, provider death mid-turn, no late revival | NOT RUN |
| Continuity and recovery | Loaded session keeps model and instructions; interrupted run resumes or Retry works | Partial: prompt-free resume only (see Kill and resume) |
| Qualification suite | All 24 `antigravity-qualification` cells, local and Daytona | NOT RUN |
| Evals under the native Runner | Applicable Product E2E and chat cases run with Antigravity; numbers recorded | NOT RUN |
| Image pull and startup time | Daytona image with the Linux closure, measured cold | NOT RUN |

### Must pass live before the qualification flip

1. All 24 `antigravity-qualification` cells, local (darwin-arm64) and Daytona
   (linux-x64).
2. The 14-cell API-key lineup, each with an accepted prompt.
3. The Gemini 4 lineup, including Neon at every level, on a paid key.
4. A live `session/load` observed before the profile claims
   `recovery: "session-load"`.
5. The attended Google sign-in journey on 1.5.2 (local only).
6. Daytona image pull and startup time, measured.

### Excluded or unsupported for this release

- Orchestrator mode: excluded. 1.5.2 does not expose it over ACP.
- Google sign-in in a cloud sandbox: refused at save and Test.
- Warm (session-reusing) runs: per-turn only.
- darwin-x64: no native host; inventory only.
- linux-arm64: verified statically; not started, so not claimed.

### Operator recipe (local, API key)

1. Install the runtime: `paperclipai runtime setup antigravity`. It downloads
   the pinned 1.5.2 archive, checks it against the registry checksum and
   installs the patched closure for this host (darwin-arm64 or linux-x64).
2. In Paperclip, add an AI connection for Google Antigravity and choose the
   Google API key method, paste a Gemini API key and use Test.
3. On the agent, pick Google Antigravity and choose a model family and thinking
   level. A free-tier key can be admitted but may be refused at prompt time;
   Neon needs a paid key.
4. Not supported: Google sign-in in a cloud sandbox, warm sessions,
   Orchestrator mode, darwin-x64.

While the profile is pending, a cloud (Daytona) run needs an operator grant
for the company and exact model that names linux-x64 and the patched linux-x64
closure, with an API-key connection, per-turn. The runner E2E harness stages
that grant for Daytona cells; a local cell's grant names the host instead.
With that grant, the agent picker offers Google Antigravity for a Core sandbox
or SSH environment that is linux-x64 with a supported glibc (or the managed
cloud image), and for this host only a grant that names this host. It offers
nothing for a plugin Runner-task environment (the warm Agent Computer in
Paperclip Cloud): that path cannot launch Antigravity yet (see Open decisions).

### Launch integrity follow-up (2026-11-22)

The sealed verified store removed the per-launch closure copy, but its first
version trusted the store's recorded kernel identity for the executable. A
process running as the runner's user can rewrite both a stored file and that
record, so the launcher would have spawned a replaced executable. The launcher
again hashes the exact executable descriptor it spawns against the pinned digest
(streamed in 4 MiB chunks, so memory stays bounded), and the module guard still
hashes every Node module at load. The store also now holds the closure's module
guard beside its entrypoints, which Pi's pinned `pi-entry.cjs` hands to its
child; without it Pi launches from the store failed. The Kimi, Pi and Copilot
provider-death fixtures now target the store and per-launch directory layout.

### Integration round (2026-11-22, no live cells yet)

- Typed turn failures reach the user: a refused model is named with its fix
  (`antigravityModelRefusalMessage`), a 503 overload takes the bounded capacity
  retry, rate limits and quotas take the provider-limit wait, a rejected key is
  shown as the provider's plain message.
- Save and Test refuse Google sign-in in a cloud environment (route test).
- A refused saved-conversation reload is `provider_state_incompatible` on every
  reopen path; Antigravity never takes the Claude-only turn-end restart.
- Superseded sealed closure stores are retired once no live runner holds them.
- A verified provider pack is re-checked by kernel identity on the same sandbox
  (958 MB / 18,002 files: 4.3 s full re-hash, ~0.25 s on a reused lease in
  Daytona).
- CI builds the Daytona image and controller pack with the selected pending
  candidates; the qualification suite gained `permission-deny-stop` (24 cells).
- Live: the Gemini key still returns 429 `RESOURCE_EXHAUSTED` for
  `gemini-3.8-flash`, so no live cell ran.

## Open decisions

- A paid Gemini key for the prompt-dependent gates (the API-key route to Neon
  is admitted; inference is unproven).
- Orchestrator mode: excluded for this release (not exposed over ACP in 1.5.2).
- Merge and production flip after the PR is green.
- Disposition of community PR #21121 (separate legacy-style adapter).
- Plugin Runner-task environments. Paperclip Cloud's warm Agent Computer runs
  agents only as plugin Runner tasks, and that path has no Antigravity launch:
  the plugin task credential contract has no Gemini API key type, the plugin
  prepares the provider launch without a candidate grant (so a pending profile
  is refused by the sidecar), the Cloud plugin's harness table lists only Codex,
  Claude and OpenCode, and Test refuses the path. Kimi, Copilot and Pi do not
  run there either. Closing it needs a plugin SDK contract change plus a Cloud
  plugin and image change.
