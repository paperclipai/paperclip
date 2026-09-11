# Cross-agent instruction editing with dual authorization and content history

Status: Proposed
Date: 2026-08-06

## Why this exists

Paperclip already lets operators manage agent instruction bundles through the API and UI. However, delegating instruction maintenance to a leadership agent exposes two narrower gaps:

1. the existing direct-edit permission also authorizes broader agent configuration changes; and
2. instruction file mutations do not retain content-level history that can explain or restore exactly what changed.

The desired outcome is a governed way for an authorized agent to edit another agent's managed instructions, subject to the responsible user's authority, with an inspectable and reversible content trail.

## Current system findings

### Instruction bundles are API-mediated

The agent routes expose bundle metadata and file operations through `GET/PATCH /api/agents/:id/instructions-bundle` and `GET/PUT/DELETE /api/agents/:id/instructions-bundle/file`. The agent detail UI already provides a file tree and editor.

`server/src/services/agent-instructions.ts` supports two ownership modes:

- **managed**: Paperclip owns the bundle directory under the instance root; and
- **external**: Paperclip reads a user-provided path but does not own it.

### Existing permissions are close, but too broad

Instruction mutations currently use the `agent_config:update` authorization action with `requiresChangeGrant: true`.

- `agents:configure` permits a direct change.
- `agents:suggest-changes` permits a change after the consent gate accepts it.
- agent run JWTs carry a responsible-user identity, and the authorization service intersects an agent's allowed decision with the responsible user's access.

That intersection already supplies the core dual-authorization behavior. The missing piece is an instruction-specific permission that does not also grant broader adapter, budget, or permission configuration authority.

### Audit records do not retain instruction contents

Instruction mutations write activity events and may write `agent_config_revisions` records. Those revisions snapshot adapter configuration, while file activity records path and size. They do not store the before/after instruction content or a restorable content revision.

Public PR [#7700](https://github.com/paperclipai/paperclip/pull/7700) proposes reliable file-write revision proof using path, size, and SHA-256 metadata. That is useful audit evidence, but it intentionally does not provide content history or content rollback, so this plan treats it as complementary rather than duplicative.

### Direct disk edits remain outside API attribution

Managed instruction bundles are ordinary files. A local process with sufficient filesystem access can change them without using the API. Paperclip cannot reliably attribute such an edit after the fact, but it can detect divergence and capture the observed content.

## Proposed feature

### 1. Add a narrow `agents:edit-instructions` permission

Add a permission key that authorizes instruction bundle mutations without granting general agent configuration access. Support the existing principal grant model for both agents and users, with target scope restricted to one of:

- all agents in the company;
- the principal agent's reporting subtree; or
- an explicit target-agent allowlist.

Default to no grant. Agents without the direct grant continue through the suggestion and consent path.

Public PR [#8798](https://github.com/paperclipai/paperclip/pull/8798) separately proposes self-edit access. The final authorization matrix should define self-edit and cross-agent edit independently so one does not accidentally imply the other.

### 2. Reuse responsible-user intersection

Map the narrow permission into the existing protected-change authorization flow. A cross-agent direct edit is allowed only when:

1. the acting agent has `agents:edit-instructions` for the target; and
2. the responsible user is an active company member whose own authorization allows the same target change.

Runs without a responsible user must not receive standing cross-agent edit authority. Protected-agent policy continues to require an explicit approval path even when both principals have direct grants.

The fallback consent path must first bind approval to the exact mutation. Public issue [#10714](https://github.com/paperclipai/paperclip/issues/10714) shows that the current gate binds acceptance to a target key, not to the file path, verb, and content. Before this feature relies on that gate, require an immutable digest or stored proposal covering the exact path, operation, and bytes being applied.

### 3. Add instruction content revisions

Add an `agent_instruction_revisions` table with:

- company, agent, and relative path;
- operation (`create`, `update`, `delete`, `restore`, `external_edit`, or `adopt`);
- before/after SHA-256 hashes;
- restorable before/after content, subject to a documented size limit;
- actor agent, responsible user, board user, and run attribution where available;
- source and optional `rolled_back_from_revision_id`; and
- creation timestamp with indexes for company/agent/path/history queries.

Content that exceeds the inline limit should use an immutable artifact/blob reference rather than a non-restorable diff alone.

Filesystem writes and PostgreSQL commits cannot share one transaction, so API mutations need a durable intent protocol rather than an impossible atomicity claim:

1. serialize mutations for one bundle, capture the current bytes/hash, and stage the requested bytes in a same-directory temporary file;
2. commit a database mutation intent containing a unique mutation ID, operation, path, before/after hashes, and restorable before/after content, with status `pending`;
3. apply the filesystem change with an atomic same-filesystem rename and `fsync` the file and parent directory; deletes first rename the old file to a mutation-scoped tombstone instead of unlinking it;
4. finalize the intent, revision, file-head state, and activity entry in one database transaction; and
5. remove staged/tombstone files only after finalization and the configured recovery window.

The API reports success only after finalization. A startup/read-path reconciler resumes pending intents idempotently: an on-disk after-hash finalizes the database records, a before-hash aborts the intent and removes staging, and any third state restores the recorded before image or marks the bundle blocked for operator recovery. Each step is keyed by the mutation ID, so retrying cannot create a second revision or activity event. Tests must inject failure after each boundary, including database failure after the filesystem rename.

Expose company-scoped list/get/restore endpoints. Restore creates a new revision instead of mutating history.

### 4. Restrict standing cross-agent writes to managed bundles

Apply the new direct permission only to managed bundles. Keep external bundles unavailable to cross-agent writers and offer an explicit adoption flow that:

1. validates and copies the bundle into the managed root;
2. records the initial content revisions;
3. updates bundle mode only after the copy succeeds; and
4. records an auditable adoption event.

On managed-bundle reads and run materialization, reconcile a stable snapshot of the complete normalized path-to-hash map, not only files that still exist. Serialize reconciliation with API mutations for the bundle, retry a scan if its path set changes while hashing, and compare the final manifest with persisted file-head rows. One observation must record:

- `create` entries for new paths;
- `update` entries for changed hashes;
- `delete` entries for missing paths, retaining the previous content as the before image; and
- a shared observation ID for matching delete/create hashes so a likely rename is visible without claiming certainty.

Store a bundle generation and manifest fingerprint. The reconciliation transaction locks the bundle head, inserts the observation under a unique `(agent_id, baseline_generation, manifest_fingerprint)` key, writes every per-path `external_edit` revision, and advances the generation and file heads together. Concurrent readers that lose the uniqueness race reload the head and become a no-op or reconcile again against the new generation. This captures deletions and both sides of renames while preventing duplicate revisions for one observed state.

Detection makes drift visible; it must not claim actor attribution that Paperclip cannot prove.

### 5. Surface cross-agent edits

Add a history view to the instruction editor with per-file diffs, actor/responsible-user attribution, mutation source, and restore controls. When an agent edits another agent's instructions, also surface a notification in an existing operator-visible feed rather than creating an unrelated issue comment.

## Delivery phases

1. **Consent hardening**: bind approvals to the exact instruction mutation and cover replay, path, verb, and content mismatches.
2. **Schema and revision service**: add idempotent migration, content storage policy, transactional write capture, initial snapshots, and unit tests.
3. **Permission and authorization**: add the narrow key, scope semantics, responsible-user intersection, protected-agent behavior, and denial-matrix tests.
4. **API and drift detection**: add history/restore/adoption endpoints and managed-bundle divergence capture.
5. **UI and notifications**: add permission controls, history/diff/restore, adoption, and cross-agent visibility using design-system tokens.
6. **End-to-end QA**: verify the happy path, denial matrix, external bundle behavior, out-of-band detection, and rollback.

The consent hardening can proceed in parallel with the early schema design. API work depends on the revision service and authorization contract; UI and end-to-end QA follow those server contracts.

## Acceptance criteria

- An agent cannot edit another agent's instructions without an in-scope direct grant or an exact-mutation consent decision.
- A direct edit is denied when the responsible user is missing, inactive, or unauthorized.
- Protected-agent rules cannot be bypassed by the new grant.
- Cross-company targets, grants, revisions, and restores are denied.
- External bundles cannot be mutated through standing cross-agent authority.
- Every API-mediated create, update, delete, adoption, and restore has a content-level revision and activity record, including recovery after failure at each filesystem/database boundary.
- Out-of-band managed-file creates, updates, deletes, and likely renames become visible as deduplicated, unattributed `external_edit` observations.
- Operators can inspect a diff and restore a prior revision without rewriting history.
- Large-file handling remains restorable, bounded, and free of secrets in logs or activity metadata.

## Design decisions still required

1. Whether leadership grants default to reporting-subtree scope or require an explicit allowlist.
2. Whether a standing direct grant needs a one-time per-target confirmation in addition to visible notification.
3. The inline content threshold and immutable storage mechanism for larger instruction files.
4. The operator-visible notification surface for cross-agent instruction edits.

## Related public work

- [#7700](https://github.com/paperclipai/paperclip/pull/7700): file-write revision proof using hashes and sizes.
- [#8798](https://github.com/paperclipai/paperclip/pull/8798): self-edit behavior for instruction bundles.
- [#10714](https://github.com/paperclipai/paperclip/issues/10714): consent is not currently bound to exact instruction content, path, or verb.
- [#6561](https://github.com/paperclipai/paperclip/pull/6561): symlink handling in instruction bundle listing.
- [#5284](https://github.com/paperclipai/paperclip/pull/5284): external instruction-root containment.
