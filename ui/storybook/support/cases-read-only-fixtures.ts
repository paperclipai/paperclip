export type CaseDocument = {
  key: string;
  title: string;
  revision: number;
  body: string;
};

export type CaseHandoff = {
  id: string;
  phase: string;
  from: string;
  to: string;
  at: string;
  instructions: string;
  state: "delivered" | "awaiting_release" | "pending_dispatch";
  waitingReason?: string;
};

export type CaseRecord = {
  identifier: string;
  title: string;
  summary: string;
  type: string;
  status: "open" | "in_progress" | "in_review" | "done";
  project: string | null;
  updatedAt: string;
  createdAt: string;
  fields: Record<string, unknown>;
  task: null | {
    identifier: string;
    title: string;
    status: string;
    assignee: string;
    phase: string;
    description: string;
    latestUpdate?: { authorRole: string; body: string; at: string };
  };
  documents: CaseDocument[];
  handoffs: CaseHandoff[];
};

export const caseActors: Record<string, { id: string; name: string; kind: "agent" | "user" }> = {
  Implementation: { id: "agent-codex", name: "CodexCoder", kind: "agent" },
  Verification: { id: "agent-qa", name: "QAChecker", kind: "agent" },
  Triage: { id: "agent-triage", name: "Scout", kind: "agent" },
  "Spec writer": { id: "agent-spec", name: "Ada", kind: "agent" },
  Documentation: { id: "agent-docs", name: "Scribe", kind: "agent" },
  Dotta: { id: "user-dotta", name: "Dotta", kind: "user" },
};

/** Isolated HTTP fixture data for the production case pages. */
export const readonlyCaseFixtures: CaseRecord[] = [
  {
    identifier: "PAP-C104",
    title: "Prevent duplicate webhook deliveries",
    summary:
      "A provider retry can start the same intake twice. Keep one accepted delivery for each provider event, including when the first response is lost.",
    type: "Bug",
    status: "in_progress",
    project: "Paperclip",
    updatedAt: "2026-10-19T10:42:00Z",
    createdAt: "2026-10-19T09:10:00Z",
    fields: {
      source: "Slack · #engineering",
      provider: "GitHub",
      severity: "Medium",
      expected_behavior: "One accepted delivery per provider event",
      reproduction: "Replay a signed event after the first response times out",
      provider_event: { id: "evt_104", repository: { name: "paperclip", private: true } },
      delivery_attempts: [
        { request_id: "req_812", attempt: 1, result: "accepted" },
        { request_id: "req_813", attempt: 2, result: "original receipt returned" },
      ],
    },
    task: {
      identifier: "PAP-812",
      title: "Prevent duplicate webhook deliveries",
      status: "in_progress",
      assignee: "Implementation",
      phase: "Implementation",
      description:
        "## Objective\n\nMake webhook intake idempotent when the provider retries an event, including after a lost HTTP response.\n\n## Acceptance criteria\n\n- Persist one receipt per company, connection, and provider event ID.\n- Return the original receipt for an identical replay.\n- Reject a different payload under the same event ID.\n- Prove concurrent requests cannot create duplicate intake work.\n- Preserve signature verification, connection access, and independent processing of different events.\n\nSave the implementation findings, then ask Verification to exercise the HTTP boundary before human review.",
      latestUpdate: {
        authorRole: "Implementation",
        body: "Added the durable receipt and concurrent-request coverage. Focused tests pass. HTTP response-loss and replay checks still need independent verification; the outgoing workspace is finishing its save.",
        at: "2026-10-19T10:42:00Z",
      },
    },
    documents: [
      {
        key: "findings",
        title: "Investigation findings",
        revision: 2,
        body: "## Reproduction\n\nWhen a signed webhook arrives twice with the same provider event ID, both requests can create intake work before either response returns.\n\n## Proposed fix\n\nStore a durable receipt keyed by company, provider connection, and event ID. Replays return the original receipt. A different payload under the same event ID is rejected.\n\n## Boundaries\n\nPreserve signature verification and connection permissions. Unrelated events must continue to run independently.",
      },
      {
        key: "verification",
        title: "Verification checklist",
        revision: 1,
        body: "## Required evidence\n\n- Replay an identical signed event and confirm there is one intake record.\n- Lose the first HTTP response, retry, and confirm the original receipt is returned.\n- Send two concurrent copies and confirm only one request creates work.\n- Reuse the event ID with a different payload and confirm a conflict.\n- Confirm different event IDs are processed separately.\n\nSave the observed results here before requesting human review.",
      },
    ],
    handoffs: [
      {
        id: "webhook-verification",
        phase: "Verification",
        from: "Implementation",
        to: "Verification",
        at: "2026-10-19T10:42:00Z",
        instructions:
          "The deduplication receipt is implemented and the focused tests pass. Independently run the saved verification checklist against the HTTP boundary, especially concurrent retries and response loss. Add your results to the verification document. If behavior differs from the checklist, return this same task to Implementation with the smallest reproduction; otherwise request human review. The outgoing workspace is still finishing its save.",
        state: "awaiting_release",
      },
      {
        id: "webhook-implementation",
        phase: "Implementation",
        from: "Triage",
        to: "Implementation",
        at: "2026-10-19T09:25:00Z",
        instructions:
          "The retry race is reproducible and the intended behavior is clear. Implement durable provider-event deduplication using the findings document. Keep the existing signature and permission checks, add coverage for concurrent retries, and save the result before handing this same task to Verification. Do not mark the task complete at the handoff.",
        state: "delivered",
      },
      {
        id: "webhook-triage",
        phase: "Triage",
        from: "Dotta",
        to: "Triage",
        at: "2026-10-19T09:15:00Z",
        instructions:
          "Investigate the report of duplicate webhook intake. Reproduce a retry with the same event ID, record the affected path and expected behavior, then hand this task to Implementation if the fix is bounded. Ask for clarification if the provider's retry contract is ambiguous.",
        state: "delivered",
      },
    ],
  },
  {
    identifier: "PAP-C103",
    title: "Add a Slack intake channel",
    summary:
      "Turn selected Slack threads into cases while keeping the source conversation and its access rules attached to the work.",
    type: "Feature",
    status: "in_review",
    project: "Paperclip",
    updatedAt: "2026-10-19T10:30:00Z",
    createdAt: "2026-10-19T08:55:00Z",
    fields: {
      source: "Slack · #product",
      decision_needed: "Approve the first version of the intake scope",
      included: ["Explicit thread mention", "Source link", "Triage assignment"],
      deferred: ["Channel-wide import", "Automatic historical backfill"],
    },
    task: {
      identifier: "PAP-809",
      title: "Define Slack thread intake",
      status: "in_review",
      assignee: "Spec writer",
      phase: "Specification",
      description:
        "## Objective\n\nDefine the smallest useful Slack thread intake flow before implementation begins.\n\n## Acceptance criteria\n\n- Specify the explicit mention that starts intake.\n- Retain a source link and the conversation's access boundary.\n- Explain how repeat mentions avoid duplicate work.\n- Describe the case and initial triage task that are created.\n- Separate the first version from historical import and passive channel monitoring.\n\nSubmit the specification for human approval. Implementation must wait for that decision.",
      latestUpdate: {
        authorRole: "Spec writer",
        body: "The third specification revision covers explicit mentions, duplicate intake, and source permissions. It is awaiting human approval; implementation has not started.",
        at: "2026-10-19T10:30:00Z",
      },
    },
    documents: [
      {
        key: "specification",
        title: "Slack intake proposal",
        revision: 3,
        body: "## First version\n\nA person explicitly mentions the intake agent in a thread. The agent creates a case with a short summary and a source link, then starts one triage task.\n\n## Access\n\nOnly conversations the connection can read may be ingested. The case retains the source boundary; moving the task does not broaden access.\n\n## Human decision\n\nApprove this scope before implementation. Historical channel import and passive monitoring are deferred.",
      },
    ],
    handoffs: [
      {
        id: "slack-specification",
        phase: "Specification",
        from: "Triage",
        to: "Spec writer",
        at: "2026-10-19T09:20:00Z",
        instructions:
          "Draft a narrow first version for explicit Slack thread intake. Describe the user trigger, source permissions, duplicate handling, and case creation behavior. Save the specification and ask for human approval through the existing review mechanism before implementation begins.",
        state: "delivered",
      },
    ],
  },
  {
    identifier: "PAP-C102",
    title: "Explore a lighter case inbox",
    summary:
      "Collect examples of how operators browse ongoing cases before deciding whether this needs a dedicated inbox.",
    type: "Research",
    status: "open",
    project: null,
    updatedAt: "2026-10-19T10:10:00Z",
    createdAt: "2026-10-19T08:40:00Z",
    fields: {
      source: "Product conversation",
      questions: ["What needs attention?", "Which agent has the work?", "Where are the findings?"],
      constraint: "Keep the first version read-only",
    },
    task: null,
    documents: [
      {
        key: "notes",
        title: "Early observations",
        revision: 1,
        body: "## What operators look for\n\nPeople want a short list they can search and filter, followed by a page with the case's summary, current work, saved findings, and handoff history.\n\n## Open question\n\nA case can be useful before anyone starts work on it. Keep passive research visible without implying that an agent is assigned or a workflow is running.",
      },
    ],
    handoffs: [],
  },
  {
    identifier: "PAP-C101",
    title: "Check the new pricing page on mobile",
    summary:
      "Verify the pricing comparison at narrow widths and confirm that the annual billing explanation stays readable.",
    type: "Verification",
    status: "in_progress",
    project: "Website",
    updatedAt: "2026-10-19T09:55:00Z",
    createdAt: "2026-10-19T08:30:00Z",
    fields: {
      preview: "https://example.com/pricing",
      viewports: ["390px", "834px", "1440px"],
      acceptance: "Plans, prices, and billing period are readable without horizontal scrolling",
    },
    task: {
      identifier: "PAP-806",
      title: "Verify pricing page layout",
      status: "in_progress",
      assignee: "Verification",
      phase: "Verification",
      description:
        "## Objective\n\nIndependently verify the pricing page changes across desktop, tablet, and mobile.\n\n## Acceptance criteria\n\n- Inspect the comparison at 390, 834, and 1440 pixel widths.\n- Confirm each plan's price, billing period, and primary link remain readable.\n- Check keyboard navigation and increased text size.\n- Confirm the annual billing explanation does not require horizontal scrolling.\n- Save screenshots and any correction requests before human review.",
      latestUpdate: {
        authorRole: "Verification",
        body: "The desktop comparison and annual billing label pass inspection. Mobile layout, increased text size, and keyboard checks are still in progress.",
        at: "2026-10-19T09:55:00Z",
      },
    },
    documents: [
      {
        key: "checks",
        title: "Browser checks",
        revision: 1,
        body: "## Checks in progress\n\nThe desktop comparison fits and the annual billing label is visible. Mobile checks are still underway.\n\nConfirm that every plan has a readable price, billing period, and primary link. Test with keyboard focus and at increased text size before reporting the page ready for review.",
      },
    ],
    handoffs: [
      {
        id: "pricing-verification",
        phase: "Verification",
        from: "Implementation",
        to: "Verification",
        at: "2026-10-19T09:45:00Z",
        instructions:
          "The responsive pricing changes are ready to inspect. Use the preview and listed viewports to check layout, keyboard focus, and the annual billing explanation. Save screenshots and concise findings. Return this task for corrections if any plan becomes unreadable; otherwise request human review.",
        state: "delivered",
      },
    ],
  },
  {
    identifier: "PAP-C100",
    title: "Recover a stalled preview deployment",
    summary:
      "The repair is ready for verification. The next agent is paused, so the handoff is waiting and no verification run has started.",
    type: "Incident",
    status: "in_progress",
    project: "Website",
    updatedAt: "2026-10-19T09:40:00Z",
    createdAt: "2026-10-19T08:20:00Z",
    fields: {
      environment: "Preview",
      customer_impact: "None; the published site is unchanged",
      waiting_on: "Verification agent is paused",
    },
    task: {
      identifier: "PAP-803",
      title: "Restore preview deployment checks",
      status: "todo",
      assignee: "Verification",
      phase: "Verification",
      description:
        "## Objective\n\nRestore reliable preview checks without changing the published site or creating a replacement deployment.\n\n## Acceptance criteria\n\n- Refresh the expired build receipt while preserving deployment identity.\n- Confirm the preview serves the expected build.\n- Check the preview health response independently.\n- Record the repaired behavior and remaining limitations.\n\nVerification must use ordinary execution admission. A paused recipient does not count as a started or successful check.",
      latestUpdate: {
        authorRole: "Implementation",
        body: "The expired receipt is repaired and the preview is ready for an independent check. Verification is paused, so no verification run has started.",
        at: "2026-10-19T09:40:00Z",
      },
    },
    documents: [
      {
        key: "repair",
        title: "Repair notes",
        revision: 2,
        body: "## Cause\n\nThe preview check waited on an expired build receipt. The repair refreshes that receipt and retains the original deployment identity.\n\n## Remaining check\n\nAn independent verification run must confirm that the preview serves the new build and its health endpoint succeeds. That run has not started because the receiving agent is paused.",
      },
    ],
    handoffs: [
      {
        id: "preview-verification",
        phase: "Verification",
        from: "Implementation",
        to: "Verification",
        at: "2026-10-19T09:40:00Z",
        instructions:
          "The preview receipt repair is saved. Confirm the preview serves the expected build, inspect the health response, and record the result in the repair notes. The receiving agent is currently paused; this handoff is waiting for ordinary execution admission and has not started a verification run.",
        state: "pending_dispatch",
        waitingReason: "QAChecker is paused.",
      },
    ],
  },
  {
    identifier: "PAP-C99",
    title: "Investigate slow task search",
    summary:
      "Search feels slow in a larger company. Identify the expensive path and save a measured reproduction before proposing a fix.",
    type: "Bug",
    status: "open",
    project: "Paperclip",
    updatedAt: "2026-10-19T09:15:00Z",
    createdAt: "2026-10-19T08:10:00Z",
    fields: {
      source: "Customer feedback",
      reported_behavior: "Search results take several seconds to appear",
      sample_size: "About 20,000 tasks",
    },
    task: {
      identifier: "PAP-800",
      title: "Measure task search latency",
      status: "todo",
      assignee: "Triage",
      phase: "Triage",
      description:
        "## Objective\n\nFind a measured explanation for slow task search in a company with about 20,000 tasks.\n\n## Acceptance criteria\n\n- Reproduce representative searches and record their latency.\n- Separate server request time from browser rendering time.\n- Identify the expensive query or rendering path if possible.\n- Save enough detail for another person to repeat the measurement.\n\nPropose a bounded fix only after the slow path is known; ask a focused question if the available evidence is insufficient.",
      latestUpdate: {
        authorRole: "Dotta",
        body: "Please begin with latency measurements on representative data. We need a reproducible slow path before choosing an implementation change.",
        at: "2026-10-19T09:15:00Z",
      },
    },
    documents: [],
    handoffs: [
      {
        id: "search-triage",
        phase: "Triage",
        from: "Dotta",
        to: "Triage",
        at: "2026-10-19T09:15:00Z",
        instructions:
          "Reproduce the reported task-search latency using representative data. Separate request time from rendering time and save the measurements. Hand the same task to Implementation only if the slow path and a bounded fix are clear; otherwise ask a focused question with the evidence collected so far.",
        state: "delivered",
      },
    ],
  },
  {
    identifier: "PAP-C98",
    title: "Clarify the deployment guide",
    summary:
      "The guide now distinguishes a local installation from a hosted workspace and includes a verified first-run path.",
    type: "Documentation",
    status: "done",
    project: "Website",
    updatedAt: "2026-10-19T09:00:00Z",
    createdAt: "2026-10-19T07:40:00Z",
    fields: {
      audience: "First-time operators",
      outcome: "Reviewed and published",
      verified: true,
    },
    task: {
      identifier: "PAP-796",
      title: "Update the deployment guide",
      status: "done",
      assignee: "Documentation",
      phase: "Human review",
      description:
        "## Objective\n\nMake the deployment guide usable by a first-time operator choosing between a local installation and a hosted workspace.\n\n## Acceptance criteria\n\n- Present distinct local and hosted setup paths.\n- List prerequisites before the installation commands.\n- Verify the local instructions from a clean environment.\n- Check every hosted setup link.\n- Obtain human review before publishing the revised guide.",
      latestUpdate: {
        authorRole: "Documentation",
        body: "The clean-install walkthrough and hosted links passed verification. Human review is complete, and the revised guide is published.",
        at: "2026-10-19T09:00:00Z",
      },
    },
    documents: [
      {
        key: "result",
        title: "Published changes",
        revision: 2,
        body: "## Result\n\nThe deployment guide now begins with separate local and hosted paths. The local instructions were checked from a clean installation, and the hosted path links to workspace setup.\n\nHuman review is complete and the guide is published.",
      },
    ],
    handoffs: [
      {
        id: "deployment-verification",
        phase: "Verification",
        from: "Documentation",
        to: "Verification",
        at: "2026-10-19T08:20:00Z",
        instructions:
          "Walk through the local installation instructions from a clean environment and inspect the hosted setup links. Save any missing prerequisites, then request human review once both paths are coherent. Keep all findings on this case.",
        state: "delivered",
      },
    ],
  },
  {
    identifier: "PAP-C97",
    title: "Make saved findings easier to discover",
    summary:
      "Keep a small set of examples where people could not find an agent's saved result. No implementation has been scoped yet.",
    type: "Research",
    status: "open",
    project: "Paperclip",
    updatedAt: "2026-10-19T08:45:00Z",
    createdAt: "2026-10-19T07:30:00Z",
    fields: {
      source: "Operator interviews",
      examples: 3,
      next_question: "Should the latest result be visible from the task or the case list?",
    },
    task: null,
    documents: [
      {
        key: "examples",
        title: "Operator examples",
        revision: 1,
        body: "## Collected examples\n\nPeople looked in the task conversation for a report that had been saved as a document. Another person opened an old handoff and missed the revised findings.\n\nKeep collecting concrete examples before deciding whether the list, case page, or task page needs another cue.",
      },
    ],
    handoffs: [],
  },
  {
    identifier: "PAP-C96",
    title: "Review webhook replay limits",
    summary:
      "Collect the provider retry limits and expected replay window before deciding whether any changes are needed.",
    type: "Research",
    status: "open",
    project: "Paperclip",
    updatedAt: "2026-10-18T16:30:00Z",
    createdAt: "2026-10-18T16:30:00Z",
    fields: {},
    task: null,
    documents: [],
    handoffs: [],
  },
];
