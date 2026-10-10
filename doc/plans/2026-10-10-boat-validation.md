# Boat validation

**Experimental and unmerged. Local journeys and partial staging qualification passed on the sources below; final-source staging acceptance remains incomplete.** A successful build, probe, or earlier-source journey does not establish the remaining product conditions.

## Source boundary

| Surface | Source and evidence |
| --- | --- |
| Canonical combined branch | `2ef177271ad703cef598b19b0d2219297c57ca6c`, including the later scoped viewer-disconnect correction. Local controller32 qualification remains attributed to `8b2a71c1e4a9029d5a8e96ce22c760fccaab4d9f`, identical to earlier `3673939bed4cb85f20d142f950547e3a60502bca`. |
| Core branch | `754a4e792e077999989b088a910ce9d846280fda`. |
| Serving staging at this cutoff | `2df40da4587725571f94b20806b0da154418d774`, deployment11 verified at 21:20:11 UTC on 2026-10-10; official receipt checked at 21:20:39.509. Earlier product observations below remain attributed to 73b2. |
| Next staging candidate | `1830beb0c26a7ba9d5e21460426936936ffc8db4` matches current 2ef1772 runtime with only compatible migration metadata changes. Build 38087300389 is in progress; deployment12 has not occurred. Serving 2df40da lacks the later isolated viewer fix, but corrected legacy product follow-ups now passed there. |

[Candidate provenance](assets/2026-10-10-boat/evidence/final-candidate-provenance.json) records the exact comparison; [deployment11](assets/2026-10-10-boat/evidence/staging-deploy-11-verified.json) verifies the new serving commit. This is deployment proof, not a product-journey pass. The experimental staging database retains its previously applied migration prefix; future staging deployments must preserve it. The main PR retains canonical history. Deployment9 stopped at strict preflight before provider deployment mutation. Subsequent checks proved a real old-database upgrade, matching schemas, and a valid forward manifest without rewriting history, resetting the database, or bypassing a guard.

## Product outcomes

All times below are UTC on 2026-10-10. “Passed” applies only to the named observation; gaps remain explicit.

| Journey | Confirmed outcome | Limit / remaining condition |
| --- | --- | --- |
| Attach and onboard four runtime combinations | Staging73b2: fresh native Codex/Claude and legacy CLI Codex/Claude agents completed browser setup using selected API accounts. All four first jobs produced files in distinct persistent personal homes. | Corrected legacy follow-ups subsequently passed on 2df40da; latest isolated viewer fix still requires staging qualification. Two earlier partial setup records were paused and excluded. |
| Corrected legacy instructions and completion | Local32/canonical3673939 passed both follow-ups. Staging 2df40da: Claude `8efa7432` succeeded 21:21:53→21:23:29 and Codex `29b92e02` succeeded 21:21:37→21:23:29. Both actually read persistent personal `AGENTS.md`, retained their prior proof hash, and completed through the helper without a recovery run. Claude actually invoked `Skill(paperclip)`. | Claude task activity mislabeled its final helper “stopped”; the run audit showed successful helper JSON, done at 21:23:15.588, and run success. Codex first used wrong helper arguments, then corrected them and exited 0. These are recorded imperfections, not hidden failures. Older 73b2 recovery-dependent follow-ups remain historical failures. |
| Legacy CLI UI guard | Staging2df40da: existing Boat Codex and Claude runtime pages each showed only the corresponding CLI engine, selected. | Read-only UI inspection; no configuration saved and no probe invoked. |
| Native Claude cold → warm → idle → resume | Local26/8f11a70b: cold 3m46, warm 1m39 with the same runnerPID33242. Checkpoints suspended, PID disappeared, owner retired, and archive completed before ordinary follow-up resumed the same durable session with a replacement runner/new boot and unchanged hashes. Staging73b2 also passed cold 8m56, warm 1m50, physical idle disappearance, and ordinary post-idle return 6m21 with unchanged proof. | Claude provider subprocesses restart between warm turns; stable runner/session is the claim. Staging did not export the full suspended-checkpoint/ledger timeline. Earlier preparation ownership is not treated as runner identity. |
| Native Codex post-idle and computer use | Local25/c9c0a47b: second-idle continuation succeeded after exact retirement/archive, with launch/focus/keyboard/window tool receipts. Staging73b2: Cua and visible desktop passed. | Final-candidate staging rerun remains pending. |
| Vite, browser preview, and warm HMR | Local23/85746677, UI76a499cc: detached Vite retained runner/provider/server identity across warm turns; a heading hot-reloaded while an unsaved draft and page-session value stayed unchanged. Natural idle later removed the owned processes/listener. Staging73b2 launched Vite and generated a preview link. | **Staging HMR is unverified:** browser navigation returned `ERR_BLOCKED_BY_CLIENT`; no blocked-URL workaround was used. Staging first-job→development-turn runner reuse is not claimed. A later lease-selection fix also needs staging requalification. |
| Desktop viewing and human control | Local31/19d827a1 and staging73b2: normal embedded viewer keyboard events opened a terminal and entered a command with visible expected output. Native Cua, desktop rendering, and bounded viewer expiry passed. | Independent human mouse input remains unverified. IBus separation was sampled outside the runner cgroup; that sample alone is not an additional expiry test. |
| Durable file editor | Local30/ac09d6ec: normal Instructions save survived full browser reload, then original content was restored and reread. Local28/3081b748 onboarding initialized readable remote instructions. | Source-specific editor/onboarding evidence; not a new runtime-execution claim. |
| Shared Boat and separate personal folders | Distinct durable roots, concurrent listener ports, and file persistence across later resumes were observed for native and legacy agents. | One-agent cancellation while a sibling continues remains explicitly unverified. Shared Unix UID and desktop provide no per-agent OS security boundary. |
| Restore failure cleanup | A provider snapshot restore timeout caused the expected probe failure; the Boat naturally archived and the controller retired its owner, leaving zero live owners/pending actions. No manual reset or retirement was used. | A handled failure, not a successful restore. Later onboarding used a separate clean fixture. |
| Database upgrade | Local28 retained the existing computer and original migration receipt while applying upstream schema changes. Compatible staging schema/manifest checks passed and73b2 deployed. | The next candidate must pass normal deployment checks; compatibility evidence is not product acceptance. |

Receipts: [staging corrected legacy runs](assets/2026-10-10-boat/evidence/staging-11-legacy-regression.json), [local corrected legacy runs](assets/2026-10-10-boat/evidence/local-32-legacy-acceptance.json), [Claude lifecycle](assets/2026-10-10-boat/evidence/claude-cold-warm.json), [Codex second idle](assets/2026-10-10-boat/evidence/codex-second-idle.json), [local HMR](assets/2026-10-10-boat/evidence/vite-warm-hmr.json), [partial staging](assets/2026-10-10-boat/evidence/staging-73b2-acceptance.json), and [editor save](assets/2026-10-10-boat/evidence/local-30-persistent-save-proof.json).

## Checks and their limits

| Check | Recorded result |
| --- | --- |
| Current runtime CI, observed 21:32:06 | Combined `2ef177271a`: 52 successful checks, fresh 5/5 review, zero unresolved threads. |
| Current core CI, same observation | Core `754a4e792e`: 52 successful checks, two policy skips, fresh 5/5 review, zero unresolved threads. |
| Latest scoped-disconnect checks | Proof246c28c03a:16 route +44 module cases passed (60 total), and server TypeScript passed; production integrated into combined2ef1772/core754a4e. Runtime CI is recorded above; later documentation commits require separate checks. |
| Legacy correction |57 execute cases and 6 config cases passed; both adapter TypeScript checks passed. Actual local32 runs subsequently verified skill invocation and completion. |
| Clean file-resource CI | Core 5e5fe7a7: 44 passed, 0 skipped, including 7 fallback/search regressions.48 focused adapter cases and server TypeScript also passed on that source. |
| Earlier broad checks | Local29/b375f465 full build and recursive typecheck passed. Earlier native framing/cache/lifecycle checks retain their individual provenance. No combined final-head full local suite pass is claimed. |
| Frozen full local baseline | Source 2cbe65e9: all 21 projects and 158 serialized suites attempted; **34,914 passed,24 failed,338 skipped**. Original failure/skip provenance remains intact. |

[Current CI receipt](assets/2026-10-10-boat/evidence/current-head-ci-review.json) is a timestamped observation, not a guarantee of later status. [Full-suite limits](assets/2026-10-10-boat/evidence/full-suite-limits.json) preserve original failures and separately attributed retries: identified adapter-utils/migration/server cases passed focused retries;8 native failures were addressed on later revisions. Three CLI worktree cases and the persona suite remained blocked by native PostgreSQL bootstrap/shared-memory exhaustion. The isolated Git streaming retry exceeded its unchanged 300-second timeout. No unrelated IPC or kernel settings were changed. Earlier local file-resource tests skipped 41 cases; later clean CI executed 44 successfully without retroactively converting the local run into a pass.

## Resource state and remaining conditions

The [latest inventory](assets/2026-10-10-boat/evidence/local-final-resource-inventory.json) records both local computer ledgers at 21:14:08 with zero live owners and no pending actions. Provider observations at 20:38 and20:53 recorded both local fixtures, the builder, and staging archived with snapshots preserved and completed stops. These are point-in-time receipts; subsequent staging deployment/qualification may resume its fixture. They do not assert a final state after future work. After the staging11 legacy jobs, the provider naturally archived with snapshots preserved; stop `stop_23f9f3d30edcffdb` completed at 21:23:43.156 and read-only observation confirmed archived at 21:30:07.746. No manual stop was required. This newer staging receipt is included with the [legacy regression evidence](assets/2026-10-10-boat/evidence/staging-11-legacy-regression.json).

Automated semantics already have meaningful coverage: the [latest 60-case route/module receipt](assets/2026-10-10-boat/evidence/latest-core-test-provenance.json) records a pass on proof246c28c03a with exact tested-file blob hashes. It also preserves the earlier48-case Boat adapter pass on unchanged files. These checks do not replace the live journeys below.

| Condition | Existing automated evidence | Scope limit |
| --- | --- | --- |
| Sibling retirement | [Computer service tests](../../server/src/modules/computers/application/service.test.ts): “does not suspend another agent and fences admission until provider stop completes”. | Mock backend/ledger: retiring one owner must not stop the machine while another holds it; no live sibling process cancellation. |
| Detach retention | Same file: “keeps snapshot and attachment proof when detached”. | Asserts detach/stop/ledger state and rejected readmission; does not write and reread a retained file. |
| Feature off / stale viewer cleanup | [Computer route tests](../../server/src/__tests__/computer-routes.test.ts): “disables new connections and previews while preserving authenticated disconnect” and “disconnects the previous viewer when the task computer has %s”. | HTTP gate and authenticated cleanup remain usable; not a live feature-toggle sweep. |
| Company/owner denial | Route tests: “hides cross-company tasks exactly like missing tasks”; service tests: “rejects cross company scopes before provider access” and “disconnects only the exact company-scoped viewer owned by the current user without provider access”. | Express/mocked repository boundary tests; no live cross-company request claimed. |
| Crash/restart fencing | Service tests: “reconciles a crashed controller reservation only after its durable deadline” and “reuses warm process identity and port while fencing stale callbacks”. | Simulated durable state, clock and generation fences; not an actual controller crash/restart. |

Still unverified or incomplete at this cutoff:

- Deployment12/serving-source confirmation for the later isolated viewer fix, its targeted qualification, and the remaining final-source acceptance matrix. Corrected legacy follow-ups passed on deployment11.
- Staging browser preview/HMR; independent human mouse input.
- Explicit cancellation of one agent while a sibling continues on the same Boat.
- Product-level detach with retained files, feature-off cleanup, cross-company denial, and controller restart without duplicate execution. Existing confinement/conflict/lifecycle tests are useful but are not substituted for these journeys.
- CI on any subsequent documentation commit and paid-resource state after remaining qualification. Core and combined runtime checks are green on the exact sources above.

Known v1 limits: cold startup can be expensive; immutable pack reuse avoids repeat large uploads but verification/staging still costs time. Managed snapshots and never-retried private cache uploads can retain disk pending operator cleanup. Arbitrary shell writers can race editor writes; no universal filesystem CAS guarantee is claimed. Dev servers survive warm turns when detached from the provider shell’s process group and still terminate with their owning runner at timeout.

## Inspectable evidence

The [sanitized evidence index](assets/2026-10-10-boat/evidence/README.md) and provenance hashes link source-specific receipts. They exclude credentials, private URLs, raw environment/profile/log/DOM content, and private home paths.

- [Staging keyboard control](assets/2026-10-10-boat/staging-73b2-human-keyboard.jpg) and [Claude post-idle proof](assets/2026-10-10-boat/staging-73b2-native-claude-post-idle.jpg).
- [Local keyboard control](assets/2026-10-10-boat/local-31-human-keyboard.jpg).
- [Local Vite baseline](assets/2026-10-10-boat/native-vite-final-before.jpg) and [hot-reloaded result](assets/2026-10-10-boat/native-vite-final-after.jpg).
- [Corrected local Claude skill/completion](assets/2026-10-10-boat/local-32-legacy-claude-fixed.jpg) and [Codex remote instructions](assets/2026-10-10-boat/local-32-legacy-codex-fixed.jpg).

- [Staging corrected Claude completion](assets/2026-10-10-boat/staging-11-legacy-claude-complete.jpg) and [Codex completion](assets/2026-10-10-boat/staging-11-legacy-codex-complete.jpg).
