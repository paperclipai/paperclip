---
name: create-runner-adapter
description: >
  Add a new harness/provider integration to native Paperclip Runner, from
  requirements and protocol research through implementation, packaging, and
  real end-to-end acceptance. Use for new Runner adapters; legacy direct
  adapter authoring and migration are outside this skill.
---

# Add a native Runner adapter

Use this skill to add a harness to the **new, native Paperclip Runner** execution
system. Here, adapter means the provider translation and launch integration
behind a Runner harness driver. Preserve existing direct adapters and historical
records as compatibility constraints; do not route this work through their
package-authoring recipe or migrate agents as a side effect.

The complete procedure is the [Runner integration playbook](../../../doc/RUNNER-INTEGRATION-PLAYBOOK.md).
Use its [working templates](../../../doc/runner-integration-templates.md) for the
release contract, capability inventory, acceptance ledger, and failure record.
These repository files contain the decision rules and test criteria themselves.
No private chat, task, prior campaign, or separate private repository is required.
Source links identify code to inspect, not evidence that a new integration passed.

If this skill was installed separately, locate the target checkout from the
current workspace or `git rev-parse --show-toplevel`. Verify it contains
`packages/paperclip-runner` and `tests/runner-e2e`; resolve `doc/` paths there.
Follow that checkout's `AGENTS.md` and scoped rules before editing.

## Work sequence

1. **Define a finite release.** Read playbook sections 1–3. Record the user
   outcome, first environment, supported platforms, setup/auth, required
   capabilities, selected acceptance model, spending limits, and delivery target.
   Keep the complete capability inventory separate from the release requirements.
2. **Investigate the actual harness.** Use section 4. Inspect versioned official
   docs, native source or shipped code, real protocol traffic, and account/model
   behavior. Track every capability through native harness, wrapper, Runner,
   controller, and UI. Distinguish documented, observed, and qualified support.
3. **Prove one complete slice.** Use sections 5–7. Establish exact model and
   instruction admission, scoped tools and credentials, then complete one real
   Paperclip task with independently verified output and physical cleanup.
   Exercise ordinary connect/save/reopen/Test/reconnect in the selected environment;
   check database constraints and account/model routing as well as driver execution.
4. **Complete the promised behavior.** Use sections 8–10. Preserve rich events,
   durable human decisions, callback identity, recovery, cancellation, and terminal
   settlement. Keep provider-specific semantics in provider code.
5. **Prove delivery.** Use section 11. Exercise clean installed packages and the
   agreed execution environment; verify the complete runtime closure and immutable
   image identity. A source checkout or startup probe is insufficient delivery proof.
6. **Qualify the release.** Use sections 12–15. Begin with deterministic and real
   dependency checks, then run exact Product E2E cells through browser/server/DB/
   Runner/provider. Section 12 includes a repository-contained test-authoring path.
   Freeze the candidate and retain original failures, cost coverage, and cleanup.
7. **Hand off an operable result.** Use section 16 and the templates. Account for
   repository checks, exact passing evidence, remaining limits, installation,
   operation, and rollback. Keep merge, publish, deploy, and canary claims distinct.

## Rules that must survive implementation pressure

- A qualification model is a repeatable test choice, not a product allowlist.
  Verify the caller's exact model at the native boundary before the first prompt.
- Instruction transport success is insufficient: bind exact content on create
  and load, reject missing acknowledgments, and verify resulting behavior.
- A native question, semantic question, plan, and permission request are distinct
  contracts. Preserve identity and prove delivery; queued does not mean answered.
- Same conversation does not establish same process or recoverable pending input.
  Stop must reach the owned native work and prevent late callbacks from reviving it.
- A screenshot, model-authored success claim, or green unit suite cannot replace
  independent file/artifact/state/cleanup checks through the promised user path.
- Diagnose the first divergence across arguments, transport, files, persistence,
  and grader before another paid attempt. Preserve the original grade.
- Changes after a pass require an evidence-impact decision. Old results retain
  their original runtime, model, environment, and fixture identity.
- Prove spontaneous native-child loss and bounded shutdown, not only cleanup
  invoked by a test. Preserve durable expiry for each supported request kind.
- Establish the concurrency being graded: attached work must overlap finish;
  a Stop case must reach real pending work before its observation window closes.
- Keep campaign evidence, budget history, and candidate/publication state durable
  across interruptions. Reconcile shipping dependencies before final qualification.
- Preserve legacy behavior through focused regression checks. Legacy authoring,
  runtime conversion, and migration are not part of adding a native integration.

Keep new guidance shareable: put the complete lesson and reproducible acceptance
condition in tracked documentation. Do not substitute personal session links,
private task URLs, inaccessible evidence archives, or workstation-specific paths.
