import { validateChatCatalogGrade } from "./chat-catalog-contract.js";
import { loadIdentityBoundaryImplementation, type ChatCatalogDescriptor } from "./chat-catalog-registry.js";
import type { IdentityBoundaryContext } from "./chat-catalog-domains/identity-boundary-contract.js";
import { chatBoundaryFingerprint } from "./chat-boundary-fingerprint.js";

/** Entered before ordinary fixture creation or authenticated chat setup. */
export async function runChatBoundaryFlow(context: IdentityBoundaryContext, descriptor: ChatCatalogDescriptor) {
  if (context.scenario.id !== descriptor.scenarioId || context.boundaryTarget !== descriptor.boundaryTarget)
    throw new Error("Boundary context differs from its declared scenario/target");
  const fingerprint = chatBoundaryFingerprint(descriptor, context.execution);
  const implementation = await loadIdentityBoundaryImplementation(descriptor);
  const observedRuns = new Set<string>(); let observation: unknown; let failed = false;
  const ownContext: IdentityBoundaryContext = { ...context, observeResources(value) {
    for (const id of value.runIds) observedRuns.add(id); context.observeResources(value);
  } };
  await context.evidence("chat-boundary-definition.json", { scenarioId: context.scenario.id, ...fingerprint, journeyKind: "browser-boundary" });
  await context.evidence("chat-boundary-intent.json", { scenarioId: context.scenario.id, journeyKind: "browser-boundary",
    originalQuery: context.scenario.query, querySent: false, context: context.scenario.context, expectedOutcome: context.scenario.expected_outcome });
  try {
    observation = await implementation.run(ownContext);
    const grade = validateChatCatalogGrade(implementation.grade(observation));
    const checks = [...grade.checks,
      { id: "boundary-complete-conditions", passed: !implementation.coverageGaps?.length, detail: implementation.coverageGaps?.length
        ? `Missing boundary phases: ${implementation.coverageGaps.join(", ")}` : "Every required public boundary phase is implemented." },
      { id: "boundary-declared-agent-dispatch", passed: observedRuns.size >= (implementation.minimumRunCount ?? implementation.expectedRunCount)
        && observedRuns.size <= implementation.expectedRunCount, detail: "Actual observed provider admissions match the boundary's declared run bounds; nonexistent chat is never credited." }];
    await context.evidence("chat-boundary-observation.json", { scenarioId: context.scenario.id, journeyKind: "browser-boundary",
      originalQuery: context.scenario.query, querySent: false, observation, grade: { passed: checks.every(check => check.passed), checks } });
    if (checks.some(check => !check.passed)) throw new Error(`Browser boundary failed: ${checks.filter(check => !check.passed).map(check => check.id).join(", ")}`);
    return checks;
  } catch (error) { failed = true; throw error; }
  finally {
    try { await implementation.cleanup(ownContext); await context.evidence("chat-boundary-cleanup.json", { scenarioId: context.scenario.id, cleanup: "complete" }); }
    catch (error) { await context.evidence("chat-boundary-cleanup.json", { scenarioId: context.scenario.id, cleanup: "failed" }); if (!failed) throw error; }
  }
}
