import { chatCatalogAgentIsReady, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "./chat-catalog-contract.js";
import { chatNativeTimeoutEvidence } from "./chat-native-timeout-policy.js";
import { completeNativeSlackFileConditional, dispatchNativeSlackIngress, prepareNativeSlackOtherThread, slackOtherThreadBoundaryMatches, slackNativeRunCheck } from "./chat-slack-ingress.js";
import { runScopedCompanionSurface } from "./chat-companion-surface.js";
import { chatQueryWithAttachments, resolveChatQueryAttachments, verifyChatQueryAttachments, type ChatQueryAttachmentReceipt } from "./chat-query-attachments.js";
import { chatCatalogRunStatusAllowed, gradeChatCatalogRuns } from "./chat-catalog-run-policy.js";
import { chatCatalogCaseFingerprint, normalizedChatCatalogExecution } from "./chat-catalog-fingerprint.js";
import { expect } from "@playwright/test";
import { pollUntil } from "./api.js";
import { collectChatRunEvidence, sendChatMessage } from "./chat-flow.js";
import { prepareNativeStopCanonicalBoundary } from "./chat-native-stop-boundary.js";
import { chatCatalogHumanHistoryMatches, validateChatCatalogGrade, type ChatCatalogSetupBoundary, type ChatCatalogContext, type ChatCatalogGrade } from "./chat-catalog-contract.js";
import { findChatCatalogCase, loadChatCatalogImplementation } from "./chat-catalog-registry.js";
import { chatCatalogInventoryDigest } from "./chat-catalog-inventory.js";
import { resolveChatCatalogQuery } from "./chat-query-bindings.js";
import { chatRunEvidenceApi } from "./chat-run-evidence-observer.js";

/** The case owns product semantics; this flow owns the actual chat entry point and evidence lifecycle. */
export async function runChatCatalogFlow(context: ChatCatalogContext) {
  const { input, scenario } = context;
  const descriptor = findChatCatalogCase(scenario.id);
  if (!descriptor) throw new Error(`No executable chat scenario: ${scenario.id}`);
  const fingerprint = chatCatalogCaseFingerprint(descriptor, normalizedChatCatalogExecution(input.execution));
  const implementation = await loadChatCatalogImplementation(descriptor);
  if (implementation.companionSurface) return runScopedCompanionSurface(context, implementation, fingerprint);
  const slack = implementation.journeyKind === "native-slack-thread";
  const deadlineAt = Date.now() + implementation.attemptTimeoutMs - 30_000;
  Object.assign(context, { observationDeadlineAt: deadlineAt });
  let state: Record<string, unknown> | undefined;
  let observation: unknown;
  let grade: ChatCatalogGrade | undefined;
  let failed = false;
  let renderedQuery = scenario.query;
  let persistedQuery = scenario.query;
  let queryAttachments: ChatQueryAttachmentReceipt[] = [];
  let setupBoundary: ChatCatalogSetupBoundary = { humanCommentIds: [], runIds: [] };
  async function conversation() {
    await context.refreshIssue();
    const issue = context.issue();
    const runs = await context.allRuns();
    const comments = issue ? await input.api.get<Array<{ id: string; body: string; authorAgentId?: string; authorUserId?: string; issueId?: string; companyId?: string; createdByRunId?: string }>>(
      `/api/issues/${issue.id}/comments?order=asc`,
    ) : [];
    const renderedLinks = [];
    for (const comment of comments) {
      const reply = input.page.locator(`[id=${JSON.stringify(`comment-${comment.id}`)}]`);
      for (const href of await reply.locator("a[href]").evaluateAll(elements => elements.map(element => element.getAttribute("href"))))
        renderedLinks.push({ commentId: comment.id, href });
    }
    const evidence = { issue, runs, comments, renderedLinks };
    await input.evidence("chat-catalog-conversation.json", evidence);
    return evidence;
  }
  async function refresh() {
    const evidence = await conversation();
    observation = await implementation!.observe(context, state!);
    grade = validateChatCatalogGrade(implementation!.grade(observation));
    const human = evidence.comments.filter(comment => !comment.authorAgentId);
    const canonicalHuman = human[implementation!.setupHumanMessageCount ?? 0];
    const attachmentsValid = !queryAttachments.length || !!canonicalHuman && await verifyChatQueryAttachments(context, queryAttachments, canonicalHuman);
    if (queryAttachments.length) await input.evidence("chat-catalog-query-attachment-receipts.json", { receipts: queryAttachments,
      canonicalCommentId: canonicalHuman?.id ?? null, verified: attachmentsValid });
    const checks = [...grade.checks,
      { id: "catalog-complete-conditions", passed: !implementation!.coverageGaps?.length,
        detail: implementation!.coverageGaps?.length ? `Missing conditions: ${implementation!.coverageGaps.join(", ")}` : "No known catalog condition is omitted." },
      { id: "catalog-original-human-query", passed: chatCatalogHumanHistoryMatches({ implementation: implementation!, human, runIds: evidence.runs.map(run => run.id), boundary: setupBoundary, renderedQuery: persistedQuery }),
        detail: "The persisted request preserves the catalog query with only audited public-fixture identity bindings; all human turns were declared." },
      { id: "catalog-query-attachment-receipts", passed: attachmentsValid,
        detail: "Only declared production attachment suffixes are allowed, backed by same-source human receipts and independently retrieved matching bytes." },
      ...(slack ? [slackNativeRunCheck(context, evidence.runs, state)] : []),
      ...gradeChatCatalogRuns({ implementation: implementation!, companyId: input.fixtures.company.id,
        leadId: input.fixtures.agent.id, source: evidence.issue, runs: evidence.runs, observation }).checks,
    ];
    grade = { passed: checks.every(check => check.passed), checks };
    await input.evidence("chat-catalog-observation.json", { scenarioId: scenario.id, inventoryDigest: chatCatalogInventoryDigest,
      oracleVersion: implementation!.oracleVersion, observation, grade });
    return { grade, runs: evidence.runs, issue: evidence.issue };
  }
  try {
    await input.evidence("chat-catalog-definition.json", { scenarioId: scenario.id, ...fingerprint,
      suiteDefinitionHash: input.execution.suiteDefinitionHash, journeyKind: implementation.journeyKind ?? "agent-chat" });
    state = await implementation.setup(context);
    const query = await resolveChatCatalogQuery(context, implementation.queryBindings, state);
    renderedQuery = query.renderedQuery;
    if (implementation.queryOutcome === "rejected" && implementation.queryAttachments?.length) throw new Error("Rejected-query attachment branches need an explicit contract");
    queryAttachments = await resolveChatQueryAttachments(context, implementation.queryAttachments, state);
    persistedQuery = chatQueryWithAttachments(renderedQuery, queryAttachments);
    if (queryAttachments.length) await input.evidence("chat-catalog-query-attachments-before-send.json", {
      originalQuery: scenario.query, renderedQuery, persistedQuery, receipts: queryAttachments });
    await input.evidence("chat-catalog-query-binding.json", { scenarioId: scenario.id, ...query });
    const company = `/api/companies/${input.fixtures.company.id}`;
    const agents = await input.api.get<Array<{ id: string }>>(`${company}/agents`);
    if (implementation.setupPolicy?.readiness !== "preserve-scenario") for (const agent of agents) await pollUntil({ label: `catalog agent readiness ${agent.id}`,
      deadlineAt: Math.min(deadlineAt, Date.now() + 45_000), intervalMs: 500,
      load: () => input.api.get<{ lifecycleState: string; status: string; lifecycleError?: string }>(`/api/agents/${agent.id}`),
      accept: chatCatalogAgentIsReady,
      reject: value => value.lifecycleError ? "Agent setup failed; diagnostic details withheld" : undefined,
    });
    const scopes = [{ scopeType: "company", scopeId: input.fixtures.company.id },
      ...agents.map(agent => ({ scopeType: "agent", scopeId: agent.id }))];
    if (implementation.setupPolicy?.funding !== "preserve-scenario") for (const scope of scopes) await input.api.post(`${company}/budgets/policies`, { ...scope, amount: 500,
      hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
    const funding = await input.api.get<{ policies: Array<{ scopeType: string; scopeId: string; amount: number; hardStopEnabled: boolean; isActive: boolean; unpricedUsagePolicy: string }> }>(`${company}/budgets/overview`);
    if (implementation.setupPolicy?.funding !== "preserve-scenario") expect(scopes.every(scope => funding.policies.some(policy => policy.scopeType === scope.scopeType && policy.scopeId === scope.scopeId
      && policy.amount === 500 && policy.hardStopEnabled && policy.isActive && policy.unpricedUsagePolicy === "allow")), "Public funding policy persisted").toBe(true);
    await input.evidence("chat-catalog-funding.json", { scopes, mode: implementation.setupPolicy?.funding ?? "standard",
      policies: funding.policies.filter(policy => scopes.some(scope => scope.scopeType === policy.scopeType && scope.scopeId === policy.scopeId)), setupProbeUsage: "unknown; production hello probes are outside heartbeat accounting" });
    if (slack && implementation.slackIngress?.setupThread === "same-agent-distractor") await prepareNativeSlackOtherThread(context,implementation,state,deadlineAt);
    const savedLead = await input.api.get<{ adapterConfig?: { timeoutSec?: unknown } }>(`/api/agents/${input.fixtures.agent.id}`);
    const nativeTimeoutPolicy = chatNativeTimeoutEvidence({ selectedTurnTimeoutMs: input.execution.task.turnTimeoutMs,
      authoredLegacyTurnTimeoutMs: implementation.turnTimeoutMs, attemptTimeoutMs: implementation.attemptTimeoutMs,
      observationBudgetMs: implementation.attemptTimeoutMs - 30_000,
      savedAgentTimeoutSec: savedLead.adapterConfig?.timeoutSec });
    await input.evidence("chat-catalog-setup.json", { nativeTimeoutPolicy, scenario, state, inventoryDigest: chatCatalogInventoryDigest,
      oracleVersion: implementation.oracleVersion, expectedRunCount: implementation.expectedRunCount,
      minimumRunCount: implementation.minimumRunCount, effectiveNativeTurnTimeoutMs: input.execution.task.turnTimeoutMs,
      authoredLegacyTurnTimeoutMs: implementation.turnTimeoutMs,
      attemptTimeoutMs: implementation.attemptTimeoutMs });
    if (implementation.verifySetup) {
      const setupGrade = validateChatCatalogGrade(await implementation.verifySetup(context, state));
      await input.evidence("chat-catalog-prepared-state.json", setupGrade);
      expect(setupGrade.passed && (implementation.setupPolicy?.invariantCheckIds ?? []).every(id => setupGrade.checks.some(check => check.id === id && check.passed)), "Independent scenario prerequisites").toBe(true);
    }
    const setupConversation = await conversation();
    const setupHuman = setupConversation.comments.filter(comment => !comment.authorAgentId);
    expect(setupHuman.length, "Only declared genuine pre-query human turns exist").toBe(implementation.setupHumanMessageCount ?? 0);
    expect(setupConversation.runs.length <= implementation.expectedRunCount, "Setup runs count toward the total native run bound").toBe(true);
    setupBoundary = { humanCommentIds: setupHuman.map(comment => comment.id), runIds: setupConversation.runs.map(run => run.id) };
    await input.evidence("chat-catalog-setup-boundary.json", { ...setupBoundary, setupHumanMessageCount: implementation.setupHumanMessageCount ?? 0,
      expectedHumanMessageCount: implementation.expectedHumanMessageCount ?? 1, expectedRunCount: implementation.expectedRunCount });
    await input.evidence("chat-catalog-query.json", { query: scenario.query, expectedOutcome: implementation.queryOutcome ?? "persisted", journeyKind: implementation.journeyKind ?? "agent-chat" });
    if (slack) {
      const other=state.slackOtherThreadSetupReceipt as (import("./chat-catalog-contract.js").ChatSlackIngressReceipt & {runId:string})|undefined;
      const declaredOther=implementation.scenarioId==="chat-channels.reply-in-thread"&&implementation.slackIngress?.setupThread==="same-agent-distractor";
      if (setupBoundary.humanCommentIds.length || (declaredOther ? !other || !slackOtherThreadBoundaryMatches({receipt:other,runs:setupConversation.runs,companyId:input.fixtures.company.id,agentId:input.fixtures.agent.id}) : setupBoundary.runIds.length!==0)) throw new Error("Native Slack setup cannot admit undeclared canonical or unrelated work");
      state.slackIngressReceipt = await dispatchNativeSlackIngress(context, implementation, state, deadlineAt);
      await input.page.goto(new URL(`/${input.fixtures.company.issuePrefix}/issues/${context.issue()!.id}`, input.api.baseURL).href);
      if (implementation.scenarioId === "chat-channels.channel-file") await completeNativeSlackFileConditional(context, implementation, state, deadlineAt);
    } else {
      await prepareNativeStopCanonicalBoundary(context, implementation, state, renderedQuery, setupBoundary);
      await sendChatMessage(input.page, renderedQuery, chatCatalogNativePhaseRemainingBudget(context));
    }
    if (implementation.queryOutcome === "rejected") {
      const rejection = validateChatCatalogGrade(await implementation.verifyQueryRejection!(context, state));
      await input.evidence("chat-catalog-query-rejection.json", rejection);
      expect(rejection.passed, "Real browser/API query rejection").toBe(true);
    }
    if (implementation.act) await implementation.act(context, state);
    let settledAt: number | undefined;
    let passedAt: number | undefined;
    await pollUntil({ label: scenario.id, deadlineAt, intervalMs: 1_000, load: refresh,
      accept: result => {
        if (!chatCatalogNativePhaseIsTimely(context)) return false;
        if (!result.grade.passed) { passedAt = undefined; return false; }
        passedAt ??= Date.now();
        return Date.now() - passedAt >= 5_000;
      },
      reject: result => {
        if (result.runs.length > implementation.expectedRunCount) return "Scenario exceeded its declared run bound";
        if (result.runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status) && !chatCatalogRunStatusAllowed({ implementation,
          run, companyId: input.fixtures.company.id, leadId: input.fixtures.agent.id, source: result.issue, observation }))) return "Observed provider run failed";
        if (result.runs.length && result.runs.every(run => !["queued", "running"].includes(run.status)) && result.issue?.conversationState === "waiting") settledAt ??= Date.now();
        else settledAt = undefined;
        return settledAt && Date.now() - settledAt >= 15_000
          ? `Settled scenario failed: ${result.grade.checks.filter(check => !check.passed).map(check => check.id).join(", ")}` : undefined;
      }, timeoutDetail: result => result?.grade.checks.filter(check => !check.passed).map(check => check.id).join(", "),
    });
    expect(chatCatalogNativePhaseIsTimely(context), "Original selected native observation budget before final proof").toBe(true);
    const originalIssueId = context.issue()?.id;
    await input.page.reload({ waitUntil: "domcontentloaded" });
    if (!slack) await expect(input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    const persisted = await refresh();
    expect(context.issue()?.id, "Source chat survives browser reload").toBe(originalIssueId);
    expect(persisted.grade.passed, "Independent oracle survives browser reload").toBe(true);
    await implementation.verifyResult(context, state, observation);
    for (const check of persisted.grade.checks) input.check?.(check.id, check.passed, check.detail);
    await input.capture("chat-catalog-result", scenario.id, "chat-catalog-result.png");
    expect(chatCatalogNativePhaseIsTimely(context), "Original selected native observation budget includes complete final proof").toBe(true);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await conversation();
      if (state) await refresh();
      const runs = await context.allRuns();
      await input.evidence("chat-catalog-runs.json", await Promise.all(runs.map(run => collectChatRunEvidence(chatRunEvidenceApi(input), run))));
      if (["projects.project-work", "projects.project-defaults", "instance-operations.restart-service"].includes(scenario.id)) {
        for (const [runIndex, run] of runs.entries()) {
          const inspected = await input.api.get<{ trace: {status: string} | null; entries: Array<{kind?: string; frameId?: number; timestamp?: string; parsed?: unknown}> }>(`/api/heartbeat-runs/${run.id}/provider-trace`);
          const timings: Array<Record<string, unknown>> = [];
          const visit = (value: unknown, frame: {frameId?: number; timestamp?: string}) => {
            if (!value || typeof value !== "object" || timings.length >= 1000) return;
            const row = value as Record<string, unknown>;
            const state = row.state as Record<string, unknown> | undefined;
            if (row.type === "tool" && typeof row.tool === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(row.tool) && state) {
              const time = state.time as Record<string, unknown> | undefined;
              timings.push({frameId: frame.frameId, observedAt: frame.timestamp, tool: row.tool,
                status: ["pending", "running", "completed", "error"].includes(String(state.status)) ? state.status : "unknown",
                startedAtMs: typeof time?.start === "number" ? time.start : null,
                endedAtMs: typeof time?.end === "number" ? time.end : null,
                mcpRequestTimedOut: typeof state.error === "string" && state.error.includes("MCP error -32001: Request timed out")});
            }
            for (const child of Object.values(row)) if (child && typeof child === "object") {
              if (Array.isArray(child)) child.forEach(item => visit(item, frame)); else visit(child, frame);
            }
          };
          for (const frame of inspected.entries) if (frame.kind === "frame") visit(frame.parsed, frame);
          await input.evidence(`opencode-tool-timings-${runIndex}.json`, {scope: "diagnostic-pilot", traceStatus: inspected.trace?.status ?? "unavailable", timings});
        }
      }

    } catch {
      await input.evidence("chat-catalog-evidence-error.json", { incomplete: true, scenarioId: scenario.id });
      if (!failed) throw new Error("Scenario evidence collection failed");
    } finally {
      try {
        if (state) await implementation.cleanup?.(context, state);
        await input.evidence("chat-catalog-cleanup.json", { scenarioId: scenario.id, caseCleanup: "complete", instanceCleanup: "owned by existing launcher" });
      } catch (error) {
        await input.evidence("chat-catalog-cleanup.json", { scenarioId: scenario.id, caseCleanup: "failed" });
        if (!failed) throw error;
      }
    }
  }
}
