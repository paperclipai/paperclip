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
| Platforms | Live-qualified: linux-x64 (Daytona) and darwin-arm64 (local). linux-arm64: provisioned and started natively; live cell if a native host is available. darwin-x64: stays inventory-only (no native host). |
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
- The ACP layer exposes no Orchestrator mode.

## Routes to Neon

| Route | State | Needs |
| --- | --- | --- |
| Personal Google sign-in (subscription catalog) | Local macOS only today | An entitled account signed in on the test instance |
| Agent Platform (Vertex/ADC) | Advertised by the server, never exercised here | A Google Cloud project and service credentials |
| API key | Hidden by the server's catalog | A billed key, plus proof that the Developer API serves Neon and a supported way to select it (`AGY_ACP_DEFAULT_MODEL` custom model, or an owned catalog correction in the admission patch) |

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

| Gate | Required observation | Verdict |
| --- | --- | --- |
| Distribution | Clean setup verifies vendor and patched closures on each claimed platform; tamper rejected | Not started |
| API-key auth | Connection, runner credential and native `gemini-api-key` session, local and Daytona | Not started |
| Model lineup | Per model/level: admission receipt and one accepted prompt | Not started |
| Neon | Real task on `gemini-4-neon-*`, each level acknowledged | Blocked on a credential that can reach Neon |
| Ordinary task | File, artifact, accepted result, Done after reload, local and Daytona | Local macOS passed on 1.4.3 (October); 1.5.2 not started |
| Scoped tools | Semantic and MCP round trip; wrong-company and stale authority denied | Not started |
| Questions and permissions | Native identity, one continuation, denial holds | Not started |
| Stop and lifecycle | Active and pending-input Stop, child loss, no late revival | Not started |
| Continuity and recovery | Loaded session keeps model and instructions; interrupted run resumes or Retry works | Not started |
| Qualification | No operator override needed; candidate grants rejected for the released profile | Not started |
| Evals under the native Runner | Applicable Product E2E and chat cases run with Antigravity; numbers recorded | Not started |

## Open decisions

- Which Neon route to qualify first, and the credential for it.
- Orchestrator mode: not reachable over ACP in 1.5.2; proposed exclusion.
- Merge and production flip after the PR is green.
- Disposition of community PR #21121 (separate legacy-style adapter).
