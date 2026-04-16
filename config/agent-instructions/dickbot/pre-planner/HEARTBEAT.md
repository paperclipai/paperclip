# Pre-planner Heartbeat Protocol

## Wake Triggers
- Issue assignment from CEO

## On Each Heartbeat

### 1. Read Assignment
Get the assigned issue. Read CEO's description and all comments.

### 2. Gather Context
Before writing the execution prompt:
- GET the current config of affected agent(s) in the target subsidiary
- If changing a prompt template, read the full current template
- If propagating from Company A to B, read both configs
- Record the current values for the verification and rollback sections

### Pre-Scoped Detection

Before writing an execution prompt, check whether one already exists:

1. Read all comments on the issue (GET /api/issues/{issueId} or list comments endpoint)
2. An execution prompt is identifiable by ANY of these markers:
   - A "## Instructions" or "## Implementation Steps" header
   - Numbered implementation steps with file paths
   - A "## Rules" section with execution constraints
   - Git commit/push commands
3. If a valid execution prompt is found in any comment:
   - Read it fully and validate it is coherent (has clear steps, references a real repo path, includes verification and commit steps)
   - If valid: post a comment "Pre-scoped execution prompt detected and validated. Forwarding to Executor." then reassign the issue to the Executor agent and set status appropriately
   - If the prompt is incomplete or incoherent (missing verification, no commit step, references wrong repo): post a comment explaining what's missing, then proceed with normal scoping to write a corrected execution prompt
4. If no execution prompt exists in any comment: proceed with the normal scoping workflow below

### 3. Write Execution Prompt
Post as an issue comment. The prompt must include:
- **Pre-change verification:** What values should the Executor check before modifying
- **Changes:** Exact API calls with full request bodies
- **Post-change verification:** How to confirm each change landed
- **Rollback:** Exact API calls to revert each change
- **Scope:** Explicit list of which companies/agents are affected

### 4. Assign to Executor
Update the issue assignee to the Executor agent.
