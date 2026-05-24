# CTO Hermes Executor

## Purpose
Enable the CTO agent to delegate code execution, file modifications, builds, and AGENT IMPORTS to Hermes via direct API call.

## When to Delegate to Hermes

| Task | Delegate? |
|------|-----------|
| Read/write files | Yes |
| Run terminal commands / builds | Yes |
| Browser automation | Yes |
| Web search | Yes |
| **Import agents from GitHub repos** | **YES - Primary task** |
| Plan architecture | No |
| Assign tasks to other agents | No |

## Agent Import Workflow (CRITICAL)

When issue asks to import agents from a GitHub repo, follow these EXACT steps:

### Step 1: Clone the Repo
```bash
cd /tmp && rm -rf agents-repo && git clone <REPO_URL> agents-repo
```

### Step 2: Find Agent Files
```bash
# Look for YAML, JSON, or Markdown files with agent definitions
find /tmp/agents-repo -type f \( -name "*.yml" -o -name "*.yaml" -o -name "*.json" -o -name "*.md" \) | head -20
```

### Step 3: Parse and Convert
Read the agent files and convert to Paperclip format. Valid roles are ONLY:
- `ceo`, `cto`, `cmo`, `cfo`
- `security`, `engineer`, `designer`
- `pm`, `qa`, `devops`, `researcher`, `general`

### Step 4: Import via API
```bash
# For each agent, POST to Paperclip API
curl -X POST "http://localhost:3100/api/companies/${COMPANY_ID}/agents" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Agent Name",
    "role": "engineer",
    "title": "Agent Title",
    "description": "Agent description from repo",
    "status": "idle",
    "adapterType": "process",
    "adapterConfig": {},
    "capabilities": "Agent capabilities"
  }'
```

### Step 5: Verify
```bash
# Check total agent count
curl -s http://localhost:3100/api/companies/${COMPANY_ID}/agents | jq '. | length'
```

## API Endpoint
```
POST http://localhost:8080/api/v1/execute
```

## Headers
```
Content-Type: application/json
Authorization: Bearer ${HERMES_API_KEY}
```

## Example Agent Import Task
```json
{
  "task": "Import agents from https://github.com/awesome-assistants/awesome-assistants. Steps: 1) git clone repo to /tmp/agents-repo, 2) Parse assistants.yml file, 3) For each assistant, POST to http://localhost:3100/api/companies/84db1d00-c7ff-46a3-98b9-a50a041bd9a5/agents with role mapped to valid Paperclip enum, 4) Verify all 240 assistants imported",
  "toolsets": ["terminal", "file", "web"],
  "max_iterations": 50
}
```

## Safety Controls
- Always verify agent count after import
- Map unknown roles to `general`
- Never skip verification step
- Report exact number of agents imported
- **ALWAYS mark issue as done after successful import**

## How to Mark Issue as Done

After successful agent import, CTO MUST mark the issue as done:

```bash
# Get issue ID from environment or context
ISSUE_ID="${ISSUE_ID}"
COMPANY_ID="84db1d00-c7ff-46a3-98b9-a50a041bd9a5"

# Mark issue as done using Paperclip API
curl -X PATCH "http://localhost:3100/api/companies/${COMPANY_ID}/issues/${ISSUE_ID}" \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'
```

**If API route not available, use the Paperclip board UI to mark as done.**

**Never leave issue in_progress without marking done!**

## Environment Variables
| Variable | Purpose |
|----------|---------|
| `HERMES_API_URL` | Hermes API server URL |
| `HERMES_API_KEY` | Bearer auth token |
| `PAPERCLIP_API_URL` | Paperclip API (http://localhost:3100/api) |
| `COMPANY_ID` | Default company ID |
