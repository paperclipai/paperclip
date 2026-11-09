# Native completion constraint consolidation

Date: 2026-10-03. Roadmap item: 2.3. Status: implementation and provider-free calibration; live behavior is unqualified.

## Change and comparison axis

The first slice replaces the repeated final-response procedure in native task constraints with a short requirement to obtain an accepted `paperclip_finish` or `paperclip_block` result and follow that tool's reporting instructions. It removes the extra completion sentence in the Codex/runnerd and direct OpenCode backends. The existing finish/block tool descriptions still own rejection, retry, approval, link/action, explicit wait, and final-response behavior.

The production comparison axis is exactly these three files:

- `packages/paperclip-runner/src/backends/runtime-context.ts`
- `packages/paperclip-runner/src/backends/codex-native-backend.ts`
- `packages/paperclip-runner/src/backends/opencode-native-backend.ts`

Both variants start from master `2a8a99e4a5f69aa803b3f10b982f583e75a87042`. The baseline retains those three original files. The candidate changes only those three production files. All fixture, grader, admission, test and documentation repairs must be common to both variants. The fixed execution prompt, production AGENTS bundle, completion tool descriptions/schemas, operational skills, hiring, connections and delivery guidance stay identical. The prior #14961 trial measured a different change and cannot qualify this one.

## Provider-free measurement

`src/backends/native-instruction-measurement.test.ts` in the Runner package captures actual `thread/start`, `thread/resume` and `turn/start` parameters from the real runnerd facade with a scripted transport. It captures native Codex, ACPX Claude and OpenCode for input v4 and v5: eighteen receipts per variant. Every receipt records exact UTF-8 bytes, character counts and hashes of the instruction string, fixture tool schemas, turn input and their full projection. It checks finish/block descriptions, document/file rules, approval mode and identical start/resume tools and instructions. The fixture uses the actual production AGENTS file and a fixed projection of the core semantic catalog plus the reserved completion tools.

Run from `packages/paperclip-runner`:

```sh
PAPERCLIP_NATIVE_INSTRUCTION_REPORT=/absolute/path/measurement.json pnpm exec vitest run src/backends/native-instruction-measurement.test.ts
```

The receipt declares its source SHA, source file hashes, fixture hash and dirty state. A dirty overlay can aid diagnosis but is rejected for live admission. Temporary workspace paths are normalized to a fixed path for comparison. This is the complete declared Paperclip projection at that boundary, not the production server's full granted catalog or a capture of provider-owned stock prompts. Token counts, billing, provider preprocessing and cognitive consumption remain unknown. The capture distinguishes a resumed full task from the compact user-follow-up continuation envelope. Input v5 sends only new events and contract references for that continuation; its projection must remain identical between variants. Input v4 still wraps the compact message in a task envelope. Scripted resume and continuation capture do not qualify live resume behavior.

## Bounded live comparison

The explicit-only Product E2E suite is `native-instruction-consolidation`. Discovery requires no credentials:

```sh
pnpm test:e2e:runner -- --list --suite native-instruction-consolidation
```

Each source variant declares these original tasks on the same local native profiles:

| Profile | Model | Tasks |
| --- | --- | --- |
| Codex | `gpt-5.6-sol` | assigned-skill document completion; whole-task blocker |
| ACPX Claude | `claude-sonnet-5` | assigned-skill document completion; whole-task blocker |
| OpenCode | `openrouter/deepseek/deepseek-v4-flash-0731` | assigned-skill document completion; whole-task blocker |

Six cells per variant means twelve actual runs for the pair, each with one attempt. Use exact IDs with parallelism one and no automatic retry. Each cell uses the original task deadline and 1,000-cent company and agent hard stops. These budgets bound recorded Paperclip spend; they do not guarantee final provider invoice amounts. Do not run providers until the human authorizes the live scope. Stop to inspect a usable behavior failure; do not reroll it to obtain a pass.

The source gate requires clean committed sources, the declared base ancestry, one complete known source variant, no unrelated paths, the current fixture digest and all eighteen provider-free capture receipts. It rejects missing, duplicated, dirty, stale or paid capture evidence. It verifies the requested immutable source SHA when supplied. A hosted shallow checkout may fetch its exact immutable SHA from the public repository at bounded depths 8, 32 and 128, without provider keys or Git credentials. It verifies exact HEAD after each fetch. The original base-ancestry and changed-path checks must then pass. No immediate-parent substitute is used. The only admitted untracked files are the exact same-run build archive and checksum, after the existing strict hydration verifier checks them.

Admission rebuilds the TypeScript SDK from the current source with a credential-free environment and hashes the complete SDK outputs. Locally it also builds the native runner; hosted execution binds the selected native runner bytes to the verified same-run archive and records that local Rust calibration was not executed there. Preparation and verification preserve the source tree, fixture digest, metadata, build log/output hashes and selected native binary provenance. A mismatched or missing build fails before provider execution.

The human authorized the bounded twelve-run pair on 2026-10-03. This does not authorize retries, broader paid scope, a merge or separate derived-report publication.

The suite uses the original assigned-skill durable-document oracle and strict native completion grading. It retains named call-ID joins, acceptance/termination, final-response order, provider-final persistence, exact blocker owner/action/scope, workspace and issue/agent side effects, default instructions and budget evidence. Unknown or absent evidence cannot pass. No relaxed source-read matcher or provider-call join is introduced.

## Decision and evidence

Freeze both source refs, the common definition hash, models/profiles, permissions, default instructions, input construction, deadlines, budgets and compiled source identity before admission. Preserve every attempt, original grade, failure and usage receipt. Compare all six exact pairs and retained content; report new failures, new passes, unchanged failures, unchanged passes and uncomparable pairs separately. A passing total does not conceal a lost document, incomplete blocker report, extra work or a missing final response.

The reduction remains unqualified until the paired live evidence exists. Passing deterministic checks proves transport/catalog and control-plane behavior under the tested scripted inputs. A single live pair per cell gives bounded evidence, not general equivalence, causation, cost/speed trends, general coding quality, or live continuation coverage. Approval feedback and yielded continuation need their own retained cases before making broader claims. If any behavior worsens, hold this slice and inspect the original evidence before changing source or expanding paid scope.
