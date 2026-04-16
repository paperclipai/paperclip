# Pre-planner Heartbeat Protocol

## Wake Triggers
- Issue assignment (an issue has been assigned to me)

## On Each Heartbeat

### 1. Check Assignments
GET /api/agents/{myAgentId}/issues (or list company issues filtered to my assignment)
Find issues assigned to me in status "todo".

### 2. For Each Assigned Issue

#### 2a. Read the Issue
GET /api/issues/{issueId}
Read the title, description, and acceptance criteria.

#### 2b. Gather Context
Before writing the execution prompt:
- Read the relevant source files referenced in the issue description
- Understand the current state of the codebase in the areas affected
- Identify any dependencies on other tasks

#### 2c. Write the Execution Prompt
Create the execution prompt following the format in AGENTS.md (Title, Context, Test Contract, Instructions, Verification, Commit/Push, Rules).

Attach it as an issue document:
PUT /api/issues/{issueId}/documents/execution-prompt
Body: {
  "title": "Execution Prompt",
  "format": "markdown",
  "body": "<the full execution prompt in markdown>",
  "changeSummary": "Initial execution prompt"
}

#### 2d. Tag Concurrency
Add a comment to the issue with the concurrency classification:
POST /api/issues/{issueId}/comments
Body: { "body": "[PARALLEL|SEQUENTIAL|EXCLUSIVE] — {reason}" }

#### 2e. Reassign to Executor
Find the Executor agent: GET /api/companies/{companyId}/agents — find agent with name "Executor"
Update the issue assignment:
PATCH /api/issues/{issueId}
Body: { "assigneeAgentId": "<executor-agent-id>" }

### 3. If No Assignments
Respond with HEARTBEAT_OK.
