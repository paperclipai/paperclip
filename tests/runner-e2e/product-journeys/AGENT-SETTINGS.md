# Saved agent instructions

`agent-settings-persistence` verifies an ordinary instruction edit on an owned
native agent and the result of its next task. It has one provider work run and
requires the `agent-settings-write` target capability. The target provider grants
that capability only for a fresh disposable agent dedicated to this case. Its
exact name must match the prepared context and contain the current campaign ID.
It must have no previous work runs or QA settings proof block. The name is an
additional fixture binding; the target's capability grant establishes ownership.
Target configuration rejects campaigns that combine this case with another paid
journey before acquiring a target. Browser-only journeys may share the campaign.
The journey
does not edit the shared source agent, provider, model, accounts, or feature flags.

1. Read the original managed instruction entry, exact bytes, content hash, and
   content revision token. Require an empty work-run history.
   Empty or whitespace-only files use the ordinary editor value because the
   read-only page shows an empty-state message. Preserve those exact bytes too.
2. Open Instructions, select **Edit** for the entry, change the **Instruction
   file editor**, and use **Save changes**. The new procedure contains a fresh
   synthetic reference that does not occur in the task request.
   Select the configured entry through the file tree on every open or reload,
   expanding its parent folders. An existing `AGENTS.md` must not divert the edit
   from a different configured entry.
   Confirm persisted bytes and the new save audit before navigating away. The
   same confirmation applies when restoring the original instructions.
3. Reload Instructions. Require the exact saved bytes in both the browser and
   the normal read API. Verify a new `agent.files_updated` audit event with the
   signed-in user, exact owned agent, entry path, and content hash.
   Activity reads use both entity filters before the API limit. Unrelated company
   history cannot consume that page. A full owned page or foreign entity fails
   the coverage check rather than being silently filtered.
4. Create one ordinary task through the shared composer. The agent must use the
   saved procedure to produce the `settings-proof` task document. Require the
   exact reference, one committed native run on the configured provider, model,
   and environment, and current-run document authorship. Pending questions,
   checkout, or recovery cannot pass.
   The dedicated `nativePhase` column must be `committed`. The grader does not
   require `resultJson.finalizationPhase`, which normal bounded run reads can omit.
5. Reload the task and read the saved document. Verify the entry file is still
   unchanged after the agent's task.
6. Restore the original bytes through the same Instructions controls. Verify the
   restored browser/API content, its original content token, a distinct board
   save audit, and no second task run. Return to the task result for the ordinary
   authenticated screenshot.

Current instruction revisions are content tokens. Identical restored bytes have
the original token; the journey does not invent a database parent/child revision
chain. The independently retained board audit establishes each actual save.

The independent grader rejects wrong or missing settings, leaked task inputs,
foreign agents/tasks/runs/documents, a changed entry, unknown runtime identity,
uncommitted work, extra runs, and an unconfirmed restoration. A failed work run
remains failed. The public flow does not edit instructions during failed or active
work; the target's normal cleanup stops and terminates that owned agent.

Private evidence consists of `agent-settings-observations.json` and
`observation-read-failures.json` under this case's `private-stories` directory.
The first contains closed IDs, hashes, the synthetic reference, checks, and both
matched board-save receipts. Each receipt includes its audit ID, actor, agent
entity, entry path, content hash, and save source. It
does not contain raw instruction files, account bindings, or provider payloads.
Discovery and local controls do not qualify a staging run. The daily plan may
admit this case only after a genuine staging pass and reviewed source merge.
