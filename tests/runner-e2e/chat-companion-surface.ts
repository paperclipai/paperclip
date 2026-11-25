import { validateChatCatalogGrade, type ChatCatalogCase, type ChatCatalogContext, type ChatCompanionResult, type ChatCompanionSurface } from "./chat-catalog-contract.js";
import { pollUntil } from "./api.js";
export const companionScenarioId = "assistant-connections.use-scoped-client";
export function validCompanionDeclaration(value: Pick<ChatCatalogCase, "scenarioId" | "companionSurface" | "expectedRunCount" | "minimumRunCount" | "expectedHumanMessageCount" | "setupHumanMessageCount" | "requiredCredentials" | "queryBindings" | "queryAttachments" | "queryOutcome"> & { journeyKind?: string }): boolean {
  const s = value.companionSurface;
  return value.scenarioId === companionScenarioId && value.journeyKind === "scoped-external-assistant" && !!s
    && Object.keys(s).sort().join(",") === "kind,maximumModelTurns,maximumOutputTokens,maximumToolCalls,model"
    && s.kind === "scoped-external-assistant" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(s.model)
    && s.maximumModelTurns === 6 && s.maximumToolCalls === 4 && s.maximumOutputTokens === 2048
    && value.expectedRunCount === 0 && (value.minimumRunCount ?? 0) === 0 && value.expectedHumanMessageCount === 0 && (value.setupHumanMessageCount ?? 0) === 0
    && value.requiredCredentials?.includes("OPENAI_API_KEY") === true && !value.queryBindings?.length && !value.queryAttachments?.length && !value.queryOutcome;
}
export function companionReceiptChecks(surface: ChatCompanionSurface, query: string, result: ChatCompanionResult, elapsedMs: number, maximumElapsedMs: number) {
  const messages = Array.isArray(result?.messages) ? result.messages : []; const users = messages.filter(message => message.role === "user");
  return [
    { id: "companion-exact-canonical-query", passed: result?.query === query && users.length === 1 && users[0]?.content === query, detail: "The actual external-model transcript contains the original catalog request as its sole human input, without an Agent Chat substitution." },
    { id: "companion-declared-model-and-usage", passed: result?.model === surface.model && Number.isSafeInteger(result?.usage?.inputTokens) && result.usage.inputTokens > 0 && Number.isSafeInteger(result?.usage?.outputTokens) && result.usage.outputTokens > 0 && result.usage.outputTokens <= surface.maximumOutputTokens
      && Array.isArray(result?.providerResponseIds) && result.providerResponseIds.length > 0 && result.providerResponseIds.every(id => typeof id === "string" && !!id && id.length <= 240), detail: "The actual selected model supplies response identities and observed bounded input/output accounting; unknown usage cannot qualify." },
    { id: "companion-bounded-actual-transcript", passed: messages.length > 0 && messages.every(message => ["system", "user", "assistant", "tool"].includes(message.role) && typeof message.content === "string")
      && messages.filter(message => message.role === "assistant").length > 0 && messages.filter(message => message.role === "assistant").length <= surface.maximumModelTurns
      && Array.isArray(result?.toolCalls) && result.toolCalls.length > 0 && result.toolCalls.length <= surface.maximumToolCalls
      && result.toolCalls.every(call => typeof call.name === "string" && !!call.name && "arguments" in call && "result" in call)
      && typeof result?.reply === "string" && !!result.reply.trim() && messages.filter(message => message.role === "assistant").at(-1)?.content === result.reply
      && Array.isArray(result?.links) && result.links.every(link => typeof link === "string") && elapsedMs <= maximumElapsedMs,
      detail: "Actual model turns, scoped tool exchanges, final reply and elapsed time satisfy the predeclared finite companion bounds." },
  ];
}
/** Sole additional catalog surface, invoked before any Agent Chat send. The
 * domain owns real model/MCP transport and independent saved-product oracles. */
export async function runScopedCompanionSurface(context: ChatCatalogContext, implementation: ChatCatalogCase, definition: unknown) {
  if (!validCompanionDeclaration(implementation) || !implementation.runCompanionSurface || implementation.act) throw new Error("Invalid finite scoped external-assistant surface");
  const { input, scenario } = context; const attemptStarted = Date.now(); let state: Record<string, unknown> | undefined; let failed = false;
  async function sourceBoundary() {
    await context.refreshIssue(); const source = context.issue();
    const comments = source ? await input.api.get<Array<{ id: string }>>(`/api/issues/${source.id}/comments?order=asc`) : [];
    return { sourceId: source?.id ?? null, commentIds: comments.map(row => row.id), runIds: (await context.allRuns()).map(row => row.id) };
  }
  try {
    await input.evidence("chat-catalog-definition.json", { scenarioId: scenario.id, ...(definition as object), journeyKind: "scoped-external-assistant" });
    state = await implementation.setup(context);
    if (implementation.verifySetup) {
      const prepared = validateChatCatalogGrade(await implementation.verifySetup(context, state)); await input.evidence("chat-catalog-prepared-state.json", prepared);
      if (!prepared.passed) throw new Error("Scoped external-assistant prerequisite failed before model dispatch");
    }
    const before = await sourceBoundary();
    if (before.runIds.length || before.commentIds.length) throw new Error("Scoped external-assistant setup admitted unrelated native/chat work");
    await input.evidence("chat-catalog-setup.json", { scenario, state, expectedRunCount: 0, expectedHumanMessageCount: 0, companionSurface: implementation.companionSurface });
    await input.evidence("chat-catalog-query.json", { query: scenario.query, journeyKind: "scoped-external-assistant", persistedInAgentChat: false });
    const started = Date.now(); const remaining = implementation.attemptTimeoutMs - (started - attemptStarted) - 30_000;
    if (remaining <= 0) throw new Error("Scoped companion setup exhausted its declared attempt deadline");
    const signal = AbortSignal.timeout(Math.min(implementation.turnTimeoutMs, remaining));
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error("Scoped companion exceeded its actual model deadline")); signal.addEventListener("abort", onAbort, { once: true }); });
    let result: ChatCompanionResult;
    try { result = await Promise.race([implementation.runCompanionSurface(context, state, { query: scenario.query, signal }), interrupted]); }
    finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
    const receiptChecks = companionReceiptChecks(implementation.companionSurface!, scenario.query, result, Date.now() - started, implementation.turnTimeoutMs);
    state.companionSurfaceResult = result;
    await input.evidence("chat-companion-transcript.json", result);
    if (signal.aborted || receiptChecks.some(check => !check.passed)) throw new Error("Actual companion transcript or model/usage bounds failed");
    let observation: unknown;
    const observe = async () => {
      observation = await implementation.observe(context, state!); const own = validateChatCatalogGrade(implementation.grade(observation)); const after = await sourceBoundary();
      const checks = [...own.checks, ...receiptChecks,
        { id: "companion-no-agent-chat-or-native-substitution", passed: !after.runIds.length && !after.commentIds.length && after.sourceId === before.sourceId, detail: "No standing Agent Chat message or native provider admission substitutes for this actual external-assistant measurement." },
        { id: "catalog-complete-conditions", passed: !implementation.coverageGaps?.length, detail: implementation.coverageGaps?.length ? `Missing conditions: ${implementation.coverageGaps.join(", ")}` : "No known catalog condition is omitted." }];
      const grade = { passed: checks.every(check => check.passed), checks };
      await input.evidence("chat-catalog-observation.json", { scenarioId: scenario.id, observation, grade }); return grade;
    };
    const grade = await pollUntil({ label: scenario.id, deadlineAt: attemptStarted + implementation.attemptTimeoutMs - 30_000, intervalMs: 1000, load: observe, accept: value => value.passed });
    await implementation.verifyResult(context, state, observation);
    const persisted = await observe(); if (!persisted.passed) throw new Error("Scoped external-assistant oracle failed after product inspection");
    for (const check of grade.checks) input.check?.(check.id, check.passed, check.detail);
  } catch (error) { failed = true; throw error; }
  finally {
    try { if (state) await implementation.cleanup?.(context, state); await input.evidence("chat-catalog-cleanup.json", { scenarioId: scenario.id, caseCleanup: "complete", instanceCleanup: "owned by existing launcher" }); }
    catch (error) { await input.evidence("chat-catalog-cleanup.json", { scenarioId: scenario.id, caseCleanup: "failed" }); if (!failed) throw error; }
  }
}
