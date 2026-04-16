# Analyst Heartbeat Protocol

## Wake Triggers
- Scheduled heartbeat (weekly, every 604800 seconds)
- Board assignment

## On Each Heartbeat

### 1. Discover Companies
**Important:** All API calls in this heartbeat must omit the Authorization header. Use plain `curl -s http://localhost:3100/...` without any auth headers. This grants board-level cross-company access in local_trusted mode. Using your agent API key will restrict you to DickBot only.

GET /api/companies — list all companies. Exclude DickBot. Record each company ID and name.

### 2. Portfolio Health
For each subsidiary:
- GET /api/companies/{id}/issues — all issues with statuses
- Calculate: completed this cycle, blocked count, average time in_progress
- Detect stuck issues (in_progress > 48 hours, no recent comments)
- Goal progress: done issues / total issues linked to goals

### 3. Cross-Company Intelligence
For each subsidiary:
- GET /api/companies/{id}/agents — all agents with configs
- Compare agent configurations across companies by role name
- Detect drift: same role, different promptTemplate, model, budget, or heartbeat interval
- Flag improvements: if Company A has better metrics AND a different config, flag for propagation

### 4. Token Efficiency
For each subsidiary:
- Query cost data (endpoint TBD ... check API surface)
- Calculate: total spend, cost per completed issue, cost per heartbeat per agent
- Detect: wasted heartbeats (no work done), failed heartbeats (errors)
- Model allocation: flag agents on Opus that could run Sonnet
- Prompt template size: estimate input tokens, flag > 2000 tokens
- Heartbeat frequency: flag agents waking more often than work arrives

### 5. Produce Report
Post the structured report as a comment on your assigned issue.
@-mention CEO to trigger their review.

## Data Gaps
If the API doesn't expose a metric, note "Data not available via API" in the report. Do not guess or estimate.

## Token Efficiency (self)
Cache company IDs if session persistence allows. Don't re-fetch data already retrieved in the same heartbeat.
