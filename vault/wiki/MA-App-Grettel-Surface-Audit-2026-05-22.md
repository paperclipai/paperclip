---
title: MA App Grettel Surface Audit — Pre-Underwriting Workspace & AI-Toolability
date: 2026-05-22
status: Completed Research
owners: Researcher agent (ROC Dev)
depends_on: []
blocks: [Grettel-deployment ticket]
---

# MA App Grettel Surface Audit — Pre-Underwriting Workspace & AI-Toolability

This audit assesses the candidate surfaces of the Mortgage Architect (MA) application to determine which views and APIs can serve as Grettel Perez's daily pre-underwriting workspace, evaluate their AI-toolability, identify gaps against her workflow, and cross-reference with the Salesforce Deprecation and GHL Loan Roadmap.

---

## 1. Candidate Surfaces Technical Inventory

We scanned `/home/dwizy/Workspace/mortgagearchitect-ai/apps/web/src/pages/` and the backing tRPC routers in `server/routers/` and `server/routers.ts` to analyze the candidate surfaces.

### 1.1 `LoanRecord.tsx` / `LoanRecordV2.tsx` (Loan Details Page)
*   **Reads/Writes:**
    *   **Reads:** Queries local loan details, linked contact data, and AI-derived loan intelligence (close probability, risk level, estimated days to close).
    *   **Writes:** Historically read-only or supported limited local mutations; write capabilities to core loan terms are missing or fall back to Salesforce writes.
*   **Backing tRPC Endpoints:**
    *   `localLoans.getById` (Queries MySQL database, which is currently synced from Salesforce via `sync-service`).
    *   `loanRoadmap.getMilestoneHistory` (Fetches milestone execution logs from local table `milestone_execution_log`).
*   **AI-Agent Usability:**
    *   **Auth Model:** Protected procedures requiring user-session context.
    *   **Idempotency:** Read operations are highly idempotent. Writing/updating endpoints do not exist yet on `localLoans` for direct edits.
    *   **Error Contracts:** Returns clear TRPCError structures (e.g., `NOT_FOUND` if the loan is missing).
*   **Workflow Gaps vs. Grettel's Lane:**
    *   **GHL CRM Integration:** Does not read or write GHL notes or tags directly.
    *   **Stage Movements:** No capability to trigger GHL stage transitions (e.g. Preapproved -> Loan Setup -> Disclosed).
    *   **Document Tracking:** No deep-link or status display from Blend doc collection (such as `blend-docs-pending` status).
    *   **Spanish SMS:** Lacks SMS template triggers or native chat panels matching the Spanish-line cohort templates.

### 1.2 `Pipeline.tsx` + `PipelineKanban.tsx` + `LoansKanban.tsx` + `TasksKanban.tsx` (Kanban Views)
*   **Reads/Writes:**
    *   **Reads:** Grouped and paginated pipeline loan summaries, status states, and active tasks.
    *   **Writes:** Visual drag-and-drop moves on Kanban lanes.
*   **Backing tRPC Endpoints:**
    *   `localLoans.list` (Lists loans with lookback, sorting by close probability, risk, or modified date).
    *   `localLoans.getPipelineSummary` (Grouped metrics).
    *   `aeTasks.getStats` / `sfTasks.getSummary` (Task tracking).
*   **AI-Agent Usability:**
    *   Excellent read telemetry. Sorting by AI-derived metrics makes it easy for agents to audit stuck pipelines.
*   **Workflow Gaps vs. Grettel's Lane:**
    *   Groupings are Salesforce-status-centric (`loans.status`) rather than GHL-pipeline-stage-centric (`Launch 4` pipeline stage IDs). With Salesforce deprecation, these views will freeze unless refactored.

### 1.3 `ContactRecordV2.tsx` + `ContactsPage.tsx` / `ContactsPageV2.tsx` (Contact Records)
*   **Reads/Writes:**
    *   **Reads:** Standard contact profiles, tags, and activity lists.
    *   **Writes:** Contact profile edits.
*   **Backing tRPC Endpoints:**
    *   `localContacts.getById` and `localContacts.list` (Queries synced local contact tables).
*   **AI-Agent Usability:**
    *   Straightforward, but heavily dependent on historical Salesforce contact data rather than GHL contact custom fields.
*   **Workflow Gaps vs. Grettel's Lane:**
    *   Does not show GHL custom fields (e.g., Language, Annual Household Income, Credit Score L, Blend Portal Link) that Grettel relies on for filtering.

### 1.4 `TrinChat.tsx` + `Autonomous.tsx` (Embedded AI Chat)
*   **Reads/Writes:**
    *   **Reads:** Chat logs, session context, and system prompts.
    *   **Writes:** Appends messages, logs AI telemetry.
*   **Backing tRPC Endpoints:**
    *   `trin.ts` / `trinFacade.ts` (Orchestrates LLM calls and skills execution).
*   **AI-Agent Usability:**
    *   Fully designed for AI interaction. Auth-protected and fully integrated.
*   **Workflow Gaps vs. Grettel's Lane:**
    *   Operates as a generic side-panel rather than a structured workflow dashboard.

### 1.5 `ScenarioBuilder.tsx` + `PreapprovalExpress.tsx` (AI-Driven Calculations)
*   **Reads/Writes:**
    *   **Reads:** Scenario criteria, credit score, debt-to-income (DTI) calculations.
    *   **Writes:** Generates pre-approval letters, inserts draft records to `preapproval_letters` local tables.
*   **Backing tRPC Endpoints:**
    *   `preapprovalLetter.generate` (Creates PDFs, uploads to GCS, and submits for approval).
    *   `scenarioBuilder.ts` (Handles mortgage loan scenario permutations).
*   **AI-Agent Usability:**
    *   Highly toolable. Already driven by `/preapproval` and `/loan-scenario-analysis` CLI skills.
*   **Workflow Gaps vs. Grettel's Lane:**
    *   **Salesforce Read Lock:** `preapprovalLetter.generate` (specifically `fetchLoanDataFromSalesforce`) has a hard dependency on querying Salesforce. If Salesforce reads are frozen or deprecated, this completely breaks the pre-approval letter generation.

### 1.6 `ConciergeDashboard.tsx` (Operator / Concierge Dashboard)
*   **Reads/Writes:**
    *   **Reads:** Queries day-to-day KPI summary data (total phone touches, calls, emails, SMS sent, overdue follow-ups counts, and the front-end lead intake conversion funnel breakdown).
    *   **Writes:** None. This is a read-only telemetry dashboard.
*   **Backing tRPC Endpoints:**
    *   `concierge.getDashboardKPIs` (Fetches daily metrics and lead stage counts with a 30-second polling interval).
*   **AI-Agent Usability:**
    *   **Auth Model:** Protected procedure (`protectedProcedure`) requiring a valid operator/user session.
    *   **Idempotency:** Highly idempotent read-only query.
    *   **Error Contracts:** Standard tRPC error structures (e.g. returning unauthorized if credentials are stale).
*   **Workflow Gaps vs. Grettel's Lane:**
    *   **Operational Focus Gaps:** Designed for high-volume front-end sales/concierge dials and incomplete lead chasing (Chris/Mike lane) rather than back-end loan file structuring, pre-approval letter generation, and processing tasks.
    *   **No Active File Mutability:** Lacks fields or controls for loan structuring, doc checklist verification, or GHL note creation.

### 1.7 `TeamLanes.tsx` (ROC Group Concierge Flow Visualization)
*   **Reads/Writes:**
    *   **Reads:** Layout metadata, responsibilities list, and routing rules for each of the ROC Group team lanes (Chris, Zee, Grettel, Gerard, Ivan).
    *   **Writes:** None. This page is purely informational and acts as a handoff visualization.
*   **Backing tRPC Endpoints:**
    *   Currently mostly driven by static configurations mapped in `TEAM_LANES` array (to be dynamically loaded once DB structure is seeded).
*   **AI-Agent Usability:**
    *   No operational endpoints mapped here yet. Usable by agents as a conceptual reference of who owns which lane.
*   **Workflow Gaps vs. Grettel's Lane:**
    *   **Not Functional:** It is an informational structural diagram rather than a functional workspace or interactive control plane.

---

## 2. Recommendation: Canonical Grettel-MA-App Surface

To transition Grettel from her Jungo workspace to a robust, AI-assisted platform, we recommend building a unified, GHL-aware **`GrettelWorkspace` page** by extending:

### `LoanRecordV2` + `PipelineKanban` + `PreapprovalExpress` Combo
*   **Core Layout:**
    *   A left panel displaying GHL-derived contact notes and conversation logs.
    *   A center panel presenting loan details populated directly from **LO One + Cube** (DTI, FICO, loan structure, program rules) instead of Salesforce.
    *   A right panel containing `PreapprovalExpress` for generating pre-approval letters and an interactive chat pane powered by `TrinChat.tsx`.
*   **Why This Setup?**
    *   It places structured loan data and automated PDF rendering in the center of her screen.
    *   It isolates CRM-heavy operations (chats, reminders, tasks) on GHL while ensuring complex calculation logic remains fully governed by the MA App.

---

## 3. Recommended tRPC Endpoints for AI wrapping

To turn this surface into a fully toolable agent workspace, the following endpoints must be wrapped as Trin skill bindings or created brand-new:

### 3.1 Endpoints to Wrap:
1.  **`localLoans.getById`**: Wrap to allow AI agents to fetch the current structured loan state.
2.  **`preapprovalLetter.generate`**: Wrap to let AI agents automatically draft and stage pre-approval letters for Grettel's review.

### 3.2 Endpoints to Create:
1.  **`localLoans.updateStructuring` (LO One Write-Surface)**:
    *   **Purpose:** Allows the agent or Grettel to update loan terms (Loan Amount, Program, Down Payment, LTV, DTI, PITI) directly, writing directly to the LO One / Cube DB, bypassing Salesforce.
    *   **Idempotency:** Guided by unique transaction tokens.
2.  **`ghl.appendContactNote`**:
    *   **Purpose:** Allows agents to append structured roadmap notes (e.g. `Roadmap v1 - Structuring`) directly to the GHL contact profile.
3.  **`ghl.updatePipelineStage`**:
    *   **Purpose:** Moves the GHL opportunity along the `Launch 4` stages (Preapproved -> Loan Setup -> Disclosed) directly from the MA App UI.

---

## 4. Cross-Reference against SF Deprecation Audit

The Salesforce Deprecation Audit states that **"all AI agents and skills stopped writing to SF as of 2026-05-22."**

### ⚠️ Critical Risk Blockers identified in this Audit:
*   **`preapprovalLetter.ts` Dependency:** The pre-approval generation endpoint queries the Salesforce contact and transaction tables. If SF reads stop or the schema is deleted, pre-approval letters can no longer be generated.
    *   **Mitigation:** `preapprovalLetter.ts` must be refactored to read borrower information from GHL contact fields (Language, Credit Score, DTI, Income) and loan details from LO One + Cube API schemas.
*   **Local Loans Database Sync:** The database backing `localLoans.getById` is updated via a sync cron from Salesforce. Once the sync cron is deactivated, the local DB will go stale.
    *   **Mitigation:** Refactor `sync-service` to run `SYNC-06-cube-pipeline` and sync GHL contacts + LO One facts directly into the local MySQL tables instead of syncing from Salesforce.

---

## 5. Comparison against GHL Loan Roadmap Spec

According to `GHL-Loan-Roadmap-v1.md`, GHL is designated as the canonical workspace for pipeline stage, opportunity tracking, conversation logs, and smart lists.

| Domain | GHL Role | MA App Role | Decision |
|---|---|---|---|
| **CRM & Notes** | Canonical | Supplements | **MA App supplements GHL**. Grettel works her queue in GHL via Smart Lists, but pivots to the MA App for calculations, scenario pricing, and PDF generation. |
| **Loan Facts** | Secondary (custom fields) | Canonical (via LO One + Cube) | **MA App is Canonical**. Financial structuring parameters live in the MA App. |
| **Doc Collection** | Tracked via custom tags | Verified via Blend deep-links | **Hybrid**. GHL automates the reminder workflows while MA App displays the document checklist status. |

### Conclusion: Supplements vs. Replaces GHL
For Grettel's pre-underwriting desk lane, **the MA App supplements GHL rather than replacing it.**
GHL provides world-class smart filtering, automated Spanish SMS nurture campaigns, and unified client chats. The MA App provides the math, the AI copilot, and the PDF generation engine. Keeping them tightly integrated via tRPC bridges provides the ideal balance of CRM capability and deep loan-structuring automation.
