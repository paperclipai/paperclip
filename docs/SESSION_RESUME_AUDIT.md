# Session Resume & Parent/Child Ticket Handling Audit

## Summary

Paperclip's session resumption strategy unconditionally discards saved sessions for any new issue wakeup with `wake_reason: issue_assigned`. This prevents parent→child ticket chains from sharing context, even when the new child ticket explicitly relates to the parent. The decision logic lives in three places: (1) `shouldResetTaskSessionForWake()` in `heartbeat.ts` (upstream), (2) per-adapter resume logic (downstream), and (3) no parent_id checks anywhere in the chain. Sessions ARE preserved for comment-triggered wakeups on the same issue.

## Current State: Cross-Adapter Comparison

| Aspect | claude-local | opencode-local | codex-local |
|--------|-------------|-----------------|-------------|
| **Resume decision** | Line 422–427: `canResumeSession` checks CWD + execution target only | Line 319–323: `canResumeSession` checks CWD + execution target only | Line 481–488: Same as above, **plus** respects `forceFreshSession` fallback flag |
| **Where resume resets** | Upstream in `heartbeat.ts:shouldResetTaskSessionForWake()` | Upstream in `heartbeat.ts:shouldResetTaskSessionForWake()` | Upstream in `heartbeat.ts:shouldResetTaskSessionForWake()` |
| **Workspace key** | Per-agent home + project/execution workspace | Per-agent home + project/execution workspace | Per-agent home + project/execution workspace |
| **Session storage** | `runtime.sessionParams` (from prior run) | `runtime.sessionParams` (from prior run) | `runtime.sessionParams` (from prior run) |
| **Knows parent_id?** | ❌ No: context shape has `taskId`/`issueId` but NO `parentIssueId` | ❌ No: context shape has `taskId`/`issueId` but NO `parentIssueId` | ❌ No: context shape has `taskId`/`issueId` but NO `parentIssueId` |

## Key Findings

### 1. The Blocking Decision (Upstream, In Heartbeat.ts)

**File:** `/Users/vardaankoenig/Documents/Paperclip/koenig-ai-org/server/src/services/heartbeat.ts`

**Lines 1321–1336: `shouldResetTaskSessionForWake()`**
```typescript
export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (
    wakeReason === "issue_assigned" ||
    wakeReason === "execution_review_requested" ||
    wakeReason === "execution_approval_requested" ||
    wakeReason === "execution_changes_requested"
  ) {
    return true;  // ← UNCONDITIONAL RESET
  }
  return false;
}
```

**Impact:** This function returns `true` for ANY `issue_assigned` event, regardless of whether it's a child of the prior issue or a completely unrelated new ticket.

**Lines 4783–4785: Where it's used**
```typescript
const resetTaskSession = shouldResetTaskSessionForWake(context);
const sessionResetReason = describeSessionResetReason(context);
const taskSessionForRun = resetTaskSession ? null : taskSession;
```

When `resetTaskSession === true`, the `taskSessionForRun` is set to `null`, discarding the saved session for this run.

**Lines 5199–5205: User-facing message**
```typescript
...(resetTaskSession && sessionResetReason
  ? [
      taskKey
        ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
        : `Skipping saved session resume because ${sessionResetReason}.`,
    ]
  : []),
```

Where `describeSessionResetReason(context)` at line 1402 returns: `"wake reason is issue_assigned"`.

### 2. Downstream: All Three Adapters Receive `null` Session

**claude-local (`execute.ts:415–427`)**
```typescript
const runtimeSessionParams = parseObject(runtime.sessionParams);
const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
const canResumeSession =
  runtimeSessionId.length > 0 &&
  hasMatchingPromptBundle &&
  (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
  adapterExecutionTargetSessionMatches(runtimeRemoteExecution, executionTarget);
const sessionId = canResumeSession ? runtimeSessionId : null;
```

Since `runtime.sessionParams` is `null` when upstream says `resetTaskSession=true`, `runtimeSessionId` is empty and `canResumeSession` fails immediately.

**opencode-local (`execute.ts:315–323`)** and **codex-local (`execute.ts:477–488`)** have identical logic. The only difference is codex-local respects a transient fallback override (`forceFreshSession` flag) but still honors the upstream `null` session.

### 3. Parent/Child Issue Relationships Exist But Are NOT Consulted

**Database Schema:** `/Users/vardaankoenig/Documents/Paperclip/koenig-ai-org/packages/db/src/schema/issue_relations.ts`

```typescript
export const issueRelations = pgTable("issue_relations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  relatedIssueId: uuid("related_issue_id").notNull(),
  type: text("type").$type<"blocks">().notNull(),  // Only type is "blocks"
  ...
});
```

The `issueRelations` table tracks "blocks" relationships (e.g., "Issue A blocks Issue B") but:
- **Limitation:** Only "blocks" is supported, not "parent_of" / "child_of".
- **Non-consulted:** `shouldResetTaskSessionForWake()` never queries this table to check if the new issue is a child of the prior one.

### 4. Context Shape: No Parent Issue ID Passed to Adapters

**Type Definition:** `packages/adapter-utils/src/types.ts:122–140` (`AdapterExecutionContext`)
- Has: `context: Record<string, unknown>`
- Included keys: `taskId`, `issueId`, `issueIds`, `wakeReason`, `wakeCommentId`, etc.
- **Missing:** `parentIssueId` or `parentTaskId`

The adapters never receive information about the parent relationship, so even if downstream code wanted to check it, the data isn't available.

## Risk Assessment

### Risks of Always Resuming Sessions

1. **Context Accumulation:** If an agent handles a long parent→child→child chain, context grows unbounded. May degrade LLM response quality or exceed token limits.
2. **Memory Leaks:** Claude/Codex/OpenCode CLI sessions may retain internal state that's irrelevant to the new task.
3. **Hallucination Drift:** Older context from a different child task could confuse the agent on a new unrelated child.
4. **Operator Intent Mismatch:** User assigns a NEW issue expecting fresh perspective; agent instead builds on old session.

### Risks of Always Starting Fresh (Current)

1. **Lost Narrative Continuity:** Parent→child chains lose all context (decision history, rationale, code understanding).
2. **Duplicated Work:** Agent re-discovers patterns, re-reads same docs, re-analyzes same code.
3. **Cost Inefficiency:** More tokens spent bootstrapping context per child ticket.
4. **Poor UX for Multi-Phase Tasks:** A task split into "Phase 1 → Phase 2 → Phase 3" issues becomes three independent cold-starts.

---

## Recommended Fix (Minimum-Viable)

### Option A: Per-Adapter Session Continuity for Same Parent

**Effort:** ~5–10 lines per adapter + 30 lines in heartbeat.ts

**Approach:**

1. **Add parent_id to context shape** (adapter-utils):
   ```typescript
   // In buildPaperclipWakePayload or heartbeat context assembly:
   const priorIssueId = taskSession?.issuIdSnapshot ?? null;  // store issue id in session metadata
   context.parentIssueId = priorIssueId;  // pass to adapters
   ```

2. **Update `shouldResetTaskSessionForWake()` in heartbeat.ts:**
   ```typescript
   export function shouldResetTaskSessionForWake(
     contextSnapshot: Record<string, unknown> | null | undefined,
   ) {
     if (contextSnapshot?.forceFreshSession === true) return true;
   
     const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
     const currentIssueId = readNonEmptyString(contextSnapshot?.issueId);
     const parentIssueId = readNonEmptyString(contextSnapshot?.parentIssueId);
   
     // NEW: Allow resume if waking the same parent or child of same parent
     if (wakeReason === "issue_assigned" && currentIssueId && parentIssueId) {
       if (currentIssueId === parentIssueId) {
         return false;  // Same issue, keep session
       }
       // Optional: Allow resume for siblings (both children of same parent)
       // Requires query to issueRelations table — skip for MVP.
     }
   
     if (
       wakeReason === "issue_assigned" ||
       // ... other reasons
     ) {
       return true;
     }
     return false;
   }
   ```

3. **Adapters:** No changes needed. They already respect `runtime.sessionParams` when passed.

**Blockers/Caveats:**
- Requires storing prior issue ID in session metadata (may not be available in all session codecs).
- Still doesn't handle "sibling" tickets (two children of the same parent) — requires DB query for parent relationship.

---

## Recommended Fix (Longer-Term)

### Option B: Proper Session Continuity Design

**Scope:**
1. **Extend issueRelations** to support "parent_of"/"child_of" relationships (not just "blocks").
2. **Pass issue family context** to adapters: `{ currentIssueId, parentIssueId, siblingIssueIds }`.
3. **Query issueRelations on wake** to determine if new issue is in the same "family" as prior run.
4. **Implement session expiry policy:**
   - Resume if: new issue is child of same parent OR on same branch of family tree.
   - Reset if: new issue is unrelated (no common ancestor within N levels).
5. **Add config knob:** `sessionResumeBehavior: "always_fresh" | "same_parent" | "same_family"`.

**Effort:** ~3–5 days (1–2 per team member).

**Benefits:**
- Handles multi-phase task chains naturally.
- Prevents unbounded context accumulation (explicit family-tree limit).
- Clear operator semantics: "related tickets share context; unrelated tickets start fresh."
- Measurable: track "session resume rate" and "context accumulation depth" metrics.

---

## Code Excerpts: Decision Points

### Heartbeat.ts: Session Reset Decision
**File:** `server/src/services/heartbeat.ts`

**Line 1321–1336:**
```typescript
export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (
    wakeReason === "issue_assigned" ||
    wakeReason === "execution_review_requested" ||
    wakeReason === "execution_approval_requested" ||
    wakeReason === "execution_changes_requested"
  ) {
    return true;  // ← UNCONDITIONAL: No parent_id check
  }
  return false;
}
```

**Line 4783:** Where it's applied:
```typescript
const resetTaskSession = shouldResetTaskSessionForWake(context);
const taskSessionForRun = resetTaskSession ? null : taskSession;
```

### Claude-Local: Session Resume Check
**File:** `packages/adapters/claude-local/src/server/execute.ts`

**Line 415–427:**
```typescript
const runtimeSessionParams = parseObject(runtime.sessionParams);
const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
const hasMatchingPromptBundle =
  runtimePromptBundleKey.length === 0 || runtimePromptBundleKey === promptBundle.bundleKey;
const canResumeSession =
  runtimeSessionId.length > 0 &&
  hasMatchingPromptBundle &&
  (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
  adapterExecutionTargetSessionMatches(runtimeRemoteExecution, executionTarget);
const sessionId = canResumeSession ? runtimeSessionId : null;
```

Note: `runtime.sessionParams` comes from upstream (heartbeat) and is already `null` if reset, so this check is moot.

### Issue Relations Table
**File:** `packages/db/src/schema/issue_relations.ts` (Lines 6–30)

```typescript
export const issueRelations = pgTable("issue_relations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  relatedIssueId: uuid("related_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  type: text("type").$type<"blocks">().notNull(),  // Only "blocks" supported currently
  ...
});
```

**Note:** Only relationship type is "blocks"; no "parent_of" or "child_of" types.

---

## Summary of Recommended Fix (Option A)

1. **heartbeat.ts (25 lines)**
   - Store prior issue ID when saving task session.
   - Pass `parentIssueId` in context to adapters.
   - Update `shouldResetTaskSessionForWake()` to allow resume if `issueId === parentIssueId` (same issue) or when appropriate (siblings, via optional query).

2. **adapter-utils/types.ts (2 lines)**
   - Extend context interface to include `parentIssueId?: string`.

3. **adapters (0 lines)**
   - No changes needed; they already respect `runtime.sessionParams`.

**Result:** Child tickets can resume parent sessions; unrelated tickets still get fresh sessions.

---

## Blockers Found

1. **Schema Limitation:** `issueRelations.type` only supports "blocks"; no parent/child relationship type exists. Would need migration to support "parent_of".
2. **Session Metadata:** Not all session codecs store the prior issue ID; may need adapter-specific logic.
3. **Transient Fallback Override:** Codex-local's `forceFreshSession` flag complicates the decision logic; must be factored in.
4. **Upstream vs. Downstream Split:** Decision happens in heartbeat.ts (upstream); adapters can't override. Any fix requires heartbeat.ts changes first.

