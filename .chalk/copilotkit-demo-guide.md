# CopilotKit Demo Guide

A step-by-step script for demoing Paperclip's CopilotKit AI assistant with inline generative UI. Designed for a ~5 minute live walkthrough that showcases data visualization, inline actions, and navigation — all inside the chat sidebar.

---

## Prerequisites

1. **Paperclip running locally** (or deployed) with at least one company seeded with agents, issues, projects, and cost data.
2. **`OPENAI_API_KEY`** set in the environment (required for the CopilotKit runtime).
3. Optionally set `COPILOTKIT_MODEL` to a specific model (defaults to `gpt-5.4`).

### Recommended seed state

For the best demo, ensure the selected company has:
- 4+ agents in mixed states (active, running, paused, error)
- 10+ issues across multiple statuses and priorities
- At least 1 pending approval
- Some cost/budget data (non-zero `budgetMonthlyCents` on the company)
- An org chart with 2+ levels of reporting hierarchy

---

## Opening the Sidebar

The CopilotKit sidebar is accessible from any page. Click the **chat icon** in the bottom-right corner or look for the "Paperclip AI" panel. It opens collapsed by default.

> **Tip:** Start on the Dashboard page of a company (e.g. `/ACME/dashboard`) so the AI has rich context from the start.

---

## Demo Script

### Act 1: Overview & Data Visualization

#### 1. Dashboard Summary Card

**Prompt:** _"How's ACME doing?"_

**What happens:**
- Triggers `getDashboard` tool
- Renders **ChatDashboardCard** inline — a compact card with:
  - Agent count, issue count, budget spent (3-column layout)
  - Status sub-labels with colored dots
  - Budget utilization progress bar (green/yellow/red)
  - Pending approvals callout
  - "View Dashboard →" navigation link

**Talking points:**
- "Instead of plain text, you get a visual snapshot right in the chat."
- "The budget bar changes color based on utilization — green under 70%, yellow 70-90%, red above 90%."
- Click "View Dashboard →" to show that chat components navigate the app.

#### 2. Agent Status Grid

**Prompt:** _"Show me the agents"_

**What happens:**
- Triggers `listAgents` tool
- Renders **ChatAgentStatusGrid** — a 2-column grid of agent cards showing:
  - Status dot (green = active/running, gray = idle/paused, red = error, amber = terminated)
  - Agent name, title/role, status label
  - Clickable cards navigate to agent detail

**Talking points:**
- "Visual status at a glance — I can immediately see Carol is in an error state."
- Click an agent card to navigate to their detail page.

#### 3. Org Chart

**Prompt:** _"Show me the org chart"_

**What happens:**
- Triggers `getAgentOrgChart` tool
- Renders **ChatOrgChart** — an indented tree with connector lines:
  - Status dots on each node
  - Role labels
  - Max 3 levels deep, collapses deeper levels

**Talking points:**
- "The reporting hierarchy rendered as a tree — you can see who reports to whom."
- "This is the same data as the org chart page, but inline in the conversation."

---

### Act 2: Work Management

#### 4. Issue List

**Prompt:** _"What's in the backlog?"_

**What happens:**
- Triggers `listIssues` with `status=backlog` filter
- Renders **ChatIssueList** — a compact list showing:
  - Priority dot (red=urgent, orange=high, yellow=medium, gray=low)
  - Issue identifier in monospace (e.g. `ACME-42`)
  - Issue title (truncated)
  - Priority + status sub-label
  - Max 5 visible with "+ N more" footer
  - "View all issues →" link

**Talking points:**
- "Priority-coded dots make it easy to scan for what's urgent."
- "Only the top 5 are shown to keep the chat clean — click through to see all."

**Follow-up prompt:** _"Show me urgent issues"_
- Same visualization, filtered to urgent only.

#### 5. Create an Issue (Existing Feature)

**Prompt:** _"Create an issue titled 'Fix mobile login crash' with urgent priority"_

**What happens:**
- Triggers `createIssue` tool
- Issue created and confirmed in text
- Then ask _"Show me open issues"_ to see it appear in the ChatIssueList

**Talking points:**
- "Natural language issue creation — no forms needed."
- "And we can immediately verify it shows up in the visual list."

---

### Act 3: Budget & Costs

#### 6. Cost Breakdown

**Prompt:** _"What's our spend this month?"_

**What happens:**
- Triggers `getCostSummary` (which also fetches per-agent costs)
- Renders **ChatCostBreakdown** — a budget visualization with:
  - Large centered spend total + budget denominator
  - Utilization progress bar with color coding
  - "Top agents" section with horizontal cost bars
  - "View costs →" link

**Talking points:**
- "Budget monitoring right in the chat — no need to navigate to the costs page."
- "The top agent breakdown shows where the money is going."
- "This is unique to Paperclip — cost visibility for AI agent operations."

---

### Act 4: Approvals (The "Wow" Moment)

#### 7. List Pending Approvals

**Prompt:** _"Any pending approvals?"_

**What happens:**
- Triggers `listApprovals`
- Renders **ChatApprovalCard** — amber-bordered cards for each pending approval with:
  - "PENDING APPROVAL" badge
  - Approval type, requester, time ago
  - **Three action buttons:** Approve (green), Reject (red), Revise (outline)

**Talking points:**
- "This is where it gets interactive — not just viewing data, but taking action."
- "These are real approval requests from agents asking permission to do something."

#### 8. Take Action

**Action:** Click the **Approve** button on a pending approval.

**What happens:**
- Calls `approvalsApi.approve()` directly from the chat
- Invalidates the approvals query cache
- The approval is processed

**Talking points:**
- "One click, right in the conversation. No context switching."
- "The agent that requested this approval will now proceed with its task."
- "You can also reject or request revisions — all inline."

---

### Act 5: Suggestion Chips & Navigation

#### 9. Page-Aware Suggestion Chips

Open the sidebar on the **Dashboard** page and point out the suggestion chips below the chat input.

**What the audience sees:** Three chips — _"Dashboard overview"_, _"Check agent status"_, _"View spend"_

**Action:** Navigate to the **Issues** page. The chips update instantly:
- _"Open issues"_, _"Urgent issues"_, _"Create issue"_

Navigate to the **Agents** page:
- _"Agent status"_, _"Org chart"_, _"Agent costs"_

Navigate to the **Costs** page:
- _"Cost summary"_, _"Top spenders"_, _"Budget status"_

Navigate to the **Approvals** page:
- _"Pending approvals"_, _"Review approvals"_, _"Dashboard"_

**Talking points:**
- "The chips change instantly as you navigate — no LLM round-trip needed, they're static and page-aware."
- "Every page gets contextually relevant suggestions, so new users always know what to ask."
- "Click any chip to send it as a message — it triggers the same generative UI components we just saw."

**Action:** Click one of the chips to demo the full flow: chip → tool call → inline visualization.

#### Suggestion Chips by Page

| Page | Chip 1 | Chip 2 | Chip 3 |
|------|--------|--------|--------|
| Dashboard | Dashboard summary | Check agent status | View spend |
| Issues | Open issues | Urgent issues | Create issue |
| Agents | Agent status | Org chart | Agent costs |
| Costs | Cost summary | Top spenders | Budget status |
| Approvals | Pending approvals | Review approvals | Dashboard |
| Projects | List projects | Project issues | Create project |
| Goals | List goals | Create goal | Dashboard |
| _(default)_ | Dashboard overview | Show agents | Open issues |

#### 10. Navigation

**Prompt:** _"Take me to the projects page"_

**What happens:**
- Triggers `navigate` tool
- App navigates to `/{prefix}/projects`
- Suggestion chips update to project-relevant actions

**Talking points:**
- "Navigation updates both the page and the suggestion chips in one step."

---

## Key Demo Themes

| Theme | Where it shows |
|-------|---------------|
| **Data Visualization** | Dashboard card, cost breakdown, agent grid, org chart |
| **Actionable UI** | Approval buttons (approve/reject/revise) |
| **Navigation** | "View →" links on every card, `navigate` tool |
| **Live State** | Agent status dots, budget utilization, pending approvals |
| **Natural Language** | Issue creation, filtering, company switching |
| **Context Awareness** | Suggestions adapt to current page, knows selected company |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Sidebar shows "CopilotKit is not configured" | Set `OPENAI_API_KEY` and restart the server |
| Chat responses are plain text (no cards) | Check browser console for render errors; ensure `useCopilotActions()` is called in Layout |
| Cards show loading skeleton forever | The tool handler may be failing — check network tab for API errors |
| Navigation links don't work | Ensure a company is selected (the `companyNav` helper requires `selectedCompany`) |
| "No company selected" responses | Select a company from the company rail before chatting |
| Approval buttons don't respond | Check that the approval is still pending (may have been resolved already) |

---

## Advanced Demo Ideas

- **Multi-company:** Switch companies mid-conversation: _"Switch to the Beta company"_ then _"How's it doing?"_ — shows context updates automatically.
- **Chained actions:** _"Create an issue for the login crash, assign it to Alice, and set it as urgent"_ — single natural language command creating a fully configured issue.
- **Comparison:** Ask _"What's our spend?"_ then navigate to `/ACME/costs` — same data, two views (chat card vs full page).
- **Error state:** If an agent is in error, ask _"What's wrong with Carol?"_ then _"Pause Carol"_ — shows the AI can both report and act on status.

---

## File Reference

| File | Purpose |
|------|---------|
| `ui/src/hooks/useCopilotActions.tsx` | All tool registrations + render props |
| `ui/src/components/chat/` | Generative UI components (7 files) |
| `ui/src/components/Layout.tsx` | CopilotSidebar placement |
| `ui/src/main.tsx` | CopilotKitProvider setup |
| `server/src/routes/copilotkit.ts` | CopilotKit runtime endpoint |
| `.chalk/copilotkit-generative-ui.md` | Architecture & component specs |
| `.chalk/copilotkit-v2-migration.md` | v1→v2 migration reference |
