import type {
  WorkflowPhase,
  WorkflowRunConsoleChunk,
  WorkflowRunDetail,
  WorkflowTelemetryEvent,
} from "@paperclipai/shared";

export type WorkflowBehaviorToolCall = {
  id: string;
  name: string;
  input: unknown;
  output: unknown | null;
  ts: string;
};

export type WorkflowBehaviorSkill = {
  name: string;
  content: string;
};

export type WorkflowBehaviorDataSource = {
  id: string;
  name: string;
  kind: "tool" | "resource";
  status: "queried" | "configured" | "available";
  query: unknown | null;
  outcome: unknown | null;
};

export type WorkflowBehaviorAgent = {
  actorKind?: "agent" | "tool" | "service";
  parentAgentName?: string | null;
  phaseKey: string;
  name: string;
  status: string;
  called: boolean;
  prompt: string | null;
  promptSource: "run_input" | "workflow_handoff" | "adk_event" | "telemetry_handoff" | "runtime_service" | "unavailable";
  model: string | null;
  service: string | null;
  systemPrompt: string | null;
  output: unknown | null;
  description: string | null;
  skills: WorkflowBehaviorSkill[];
  tools: WorkflowBehaviorToolCall[];
  configuredTools: string[];
  dataSources: WorkflowBehaviorDataSource[];
};

type AdkEvent = {
  author: string | null;
  role: string | null;
  text: string[];
  calls: Array<{ id: string; name: string; input: unknown }>;
  responses: Array<{ id: string; name: string; output: unknown }>;
  ts: string;
};

type CompactLifecycleEvent = {
  event: string;
  node: string | null;
  status: string | null;
  details: Record<string, unknown>;
  ts: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function handoffTargetFromOperationName(operationName: string): string | null {
  const match = /^handoff:(.+)$/i.exec(operationName.trim());
  return asString(match?.[1]);
}

function handoffPromptFromValue(value: unknown): string | null {
  const direct = asString(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["prompt", "handoff", "content", "text", "message", "input"]) {
    const text = handoffPromptFromValue(record[key]);
    if (text) return text;
  }
  return null;
}

export function buildWorkflowTelemetryPhases(
  events: WorkflowTelemetryEvent[] | undefined,
): WorkflowPhase[] {
  if (!events?.length) return [];
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence || a.timestamp.localeCompare(b.timestamp));
  const eventBySpan = new Map<string, WorkflowTelemetryEvent[]>();
  for (const event of ordered) {
    eventBySpan.set(event.spanId, [...(eventBySpan.get(event.spanId) ?? []), event]);
  }
  // Well-formed telemetry emits a started event, but accept completed-only
  // spans too: external harnesses often report a handoff atomically.
  const spanStarts = [...eventBySpan.values()].map((spanEvents) =>
    spanEvents.find((event) => event.event === "operation.started") ?? spanEvents[0]!,
  );
  const knownSpans = new Set(spanStarts.map((event) => event.spanId));
  return spanStarts.map((event, ordinal) => {
    const spanEvents = eventBySpan.get(event.spanId) ?? [];
    const terminal = [...spanEvents]
      .reverse()
      .find((candidate) => candidate.event !== "operation.started") ?? null;
    const attributes = event.attributes ?? {};
    const input = asRecord(event.input);
    const operationKind = event.operation.kind;
    const handoffTarget = handoffTargetFromOperationName(event.operation.name);
    const kind: WorkflowPhase["kind"] = handoffTarget
      ? "phase"
      : operationKind === "tool"
      ? "tool"
      : operationKind === "agent" || operationKind === "llm" || operationKind === "service"
        ? "agent"
        : "phase";
    const phaseKey = `telemetry:${event.spanId}`;
    const parentKey = event.parentSpanId && knownSpans.has(event.parentSpanId)
      ? `telemetry:${event.parentSpanId}`
      : null;
    const startedAt = new Date(event.timestamp);
    const finishedAt = terminal ? new Date(terminal.timestamp) : null;
    const status: WorkflowPhase["status"] = terminal?.event === "operation.failed"
      ? "failed"
      : terminal?.event === "operation.completed"
        ? "succeeded"
        : "running";
    return {
      id: `telemetry-event:${event.id}`,
      companyId: event.companyId,
      workflowRunId: event.workflowRunId,
      phaseKey,
      label: event.operation.name,
      kind,
      ordinal,
      status,
      metadata: {
        runtimeCalled: true,
        runtimeAgent: kind === "agent",
        runtimePhase: kind !== "agent",
        runtimeKind: operationKind,
        handoffTarget,
        telemetrySpanId: event.spanId,
        parentKey,
        agentName: kind === "agent" ? event.actor.name ?? event.operation.name : null,
        service: operationKind === "service" ? asString(attributes.service) ?? event.operation.name : null,
        model: asString(attributes.model),
        systemPrompt: asString(attributes.systemPrompt),
        configuredTools: Array.isArray(attributes.configuredTools) ? attributes.configuredTools : [],
        configuredSkills: Array.isArray(attributes.configuredSkills) ? attributes.configuredSkills : [],
        prompt: handoffTarget
          ? handoffPromptFromValue(event.input) ?? handoffPromptFromValue(terminal?.output) ?? handoffPromptFromValue(attributes)
          : asString(input?.prompt) ?? (typeof event.input === "string" ? event.input : null),
        output: terminal?.output ?? null,
        error: terminal?.error ?? null,
        runtimeToolName: kind === "tool" ? event.operation.name : null,
        runtimeToolId: kind === "tool" ? event.spanId : null,
        runtimeToolInput: kind === "tool" ? event.input ?? {} : null,
        runtimeToolOutput: kind === "tool" ? terminal?.output ?? null : null,
      },
      startedAt,
      finishedAt,
      createdAt: new Date(event.createdAt),
      updatedAt: finishedAt ?? startedAt,
    };
  });
}

function parseEvent(line: string, ts: string): AdkEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const event = asRecord(raw);
  const content = asRecord(event?.content);
  if (!event || !content) return null;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const parsed: AdkEvent = {
    author: asString(event.author),
    role: asString(content.role),
    text: [],
    calls: [],
    responses: [],
    ts,
  };
  for (const value of parts) {
    const part = asRecord(value);
    if (!part) continue;
    const text = asString(part.text);
    if (text) parsed.text.push(text);
    const call = asRecord(part.functionCall);
    if (call) {
      const name = asString(call.name) ?? "tool";
      parsed.calls.push({
        id: asString(call.id) ?? name,
        name,
        input: call.args ?? {},
      });
    }
    const response = asRecord(part.functionResponse);
    if (response) {
      const name = asString(response.name) ?? "tool";
      parsed.responses.push({
        id: asString(response.id) ?? name,
        name,
        output: response.response ?? response,
      });
    }
  }
  return parsed;
}

function parseEvents(entries: WorkflowRunConsoleChunk[]): AdkEvent[] {
  const events: AdkEvent[] = [];
  let pending = "";
  let pendingTs = new Date(0).toISOString();
  for (const entry of entries) {
    if (entry.stream !== "stdout") continue;
    if (!pending) pendingTs = entry.ts;
    pending += entry.chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parseEvent(line.trim(), pendingTs);
      if (parsed) events.push(parsed);
      pendingTs = entry.ts;
    }
  }
  const finalEvent = parseEvent(pending.trim(), pendingTs);
  if (finalEvent) events.push(finalEvent);
  return events;
}

function parseCompactLifecycleEvents(entries: WorkflowRunConsoleChunk[]): CompactLifecycleEvent[] {
  const events: CompactLifecycleEvent[] = [];
  let pending = "";
  let pendingTs = new Date(0).toISOString();
  for (const entry of entries) {
    if (entry.stream !== "stdout") continue;
    if (!pending) pendingTs = entry.ts;
    pending += entry.chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parseCompactLifecycleLine(line, pendingTs);
      if (parsed) events.push(parsed);
      pendingTs = entry.ts;
    }
  }
  const finalEvent = parseCompactLifecycleLine(pending, pendingTs);
  if (finalEvent) events.push(finalEvent);
  return events;
}

function parseCompactLifecycleLine(line: string, ts: string): CompactLifecycleEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line.trim());
  } catch {
    return null;
  }
  const record = asRecord(raw);
  const event = asString(record?.event);
  if (!record || !event) return null;
  return {
    event,
    node: asString(record.node),
    status: asString(record.status),
    details: asRecord(record.details) ?? {},
    ts,
  };
}

function buildCompactSourceServices(entries: WorkflowRunConsoleChunk[]): WorkflowBehaviorAgent[] {
  const events = parseCompactLifecycleEvents(entries);
  const services: WorkflowBehaviorAgent[] = [];
  const starts = events.filter((event) => event.event === "source_grounding.started");
  for (const [index, started] of starts.entries()) {
    const finished = events.find((candidate) =>
      candidate.event === "source_grounding.finished" &&
      candidate.node === started.node &&
      candidate.ts >= started.ts);
    const completed = events.find((candidate) =>
      candidate.event === "source_grounding.completed" &&
      candidate.node !== null &&
      candidate.node.endsWith("_grounding") &&
      candidate.ts >= started.ts);
    const sources = Array.isArray(started.details.sources)
      ? started.details.sources.flatMap((value) => asString(value) ?? [])
      : [];
    for (const source of sources) {
      const completedOutcome = asRecord(asRecord(completed?.details.outcomes)?.[source]);
      const finishedOutcome = asRecord(finished?.details.outcome);
      const outcome = completedOutcome ?? finishedOutcome ?? (finished
        ? { status: finished.status, ...finished.details }
        : null);
      const query = {
        ...Object.fromEntries(
        Object.entries(started.details).filter(([key]) => key !== "sources"),
        ),
        ...(outcome && Object.prototype.hasOwnProperty.call(outcome, "query")
          ? { query: outcome.query }
          : {}),
      };
      services.push({
        actorKind: "tool",
        parentAgentName: started.node?.split(":", 1)[0] ?? null,
        phaseKey: `compact-source:${started.node ?? "grounding"}:${source}:${index}`,
        name: source,
        status: completed?.status ?? finished?.status ?? "running",
        called: true,
        prompt: null,
        promptSource: "runtime_service",
        model: null,
        service: "Workflow source grounding",
        systemPrompt: null,
        output: outcome,
        description: `Observed source query emitted by ${started.node ?? "the workflow"}.`,
        skills: [],
        tools: [{
          id: `compact-source-call:${source}:${index}`,
          name: source,
          input: query,
          output: outcome,
          ts: started.ts,
        }],
        configuredTools: [source],
        dataSources: [{
          id: `compact-source-data:${source}:${index}`,
          name: source,
          kind: "tool",
          status: "queried",
          query,
          outcome,
        }],
      });
    }
  }
  return services;
}

function phaseString(phase: WorkflowPhase, key: string): string | null {
  return asString(phase.metadata?.[key]);
}

function phaseStringArray(phase: WorkflowPhase, key: string): string[] {
  const value = phase.metadata?.[key];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = asString(item);
    return text ? [text] : [];
  });
}

function phaseHasRuntimeEvidence(phase: WorkflowPhase): boolean {
  return phase.metadata?.runtimeCalled === true ||
    phase.metadata?.runtimeAgent === true ||
    phase.metadata?.runtimePhase === true;
}

function phaseSkills(phase: WorkflowPhase): WorkflowBehaviorSkill[] {
  const value = phase.metadata?.configuredSkills;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const skill = asRecord(item);
    const name = asString(skill?.name);
    const content = asString(skill?.content);
    return name && content ? [{ name, content }] : [];
  });
}

function normalizeName(value: string | null): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function isWorkflowHandoffPrompt(value: string | null): boolean {
  return Boolean(value && /^Workflow:\s*[^\n]+\n\nInput:\n/s.test(value));
}

function readResourceDataSources(runDetail: WorkflowRunDetail | null): WorkflowBehaviorDataSource[] {
  const raw = runDetail?.contextSnapshot?.resourceVersions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value, index) => {
    const resource = asRecord(value);
    const name = asString(resource?.resourceKey);
    if (!resource || !name) return [];
    return [{
      id: asString(resource.resourceId) ?? `resource-${index}`,
      name,
      kind: "resource" as const,
      status: "available" as const,
      query: {
        mountPath: resource.mountPath ?? null,
        requestedRef: resource.requestedRef ?? null,
      },
      outcome: {
        resolvedRef: resource.resolvedRef ?? null,
        commit: resource.commit ?? null,
        published: resource.published ?? null,
      },
    }];
  });
}

function parseEmbeddedSkills(systemPrompt: string | null): WorkflowBehaviorSkill[] {
  if (!systemPrompt) return [];
  const matches = [...systemPrompt.matchAll(/^# SKILL\.md\s*\r?\n+---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/gm)];
  const skills: WorkflowBehaviorSkill[] = [];
  for (const [index, match] of matches.entries()) {
    const frontmatter = match[1] ?? "";
    const nameMatch = frontmatter.match(/^name:\s*["']?([^\r\n"']+)["']?\s*$/m);
    const name = asString(nameMatch?.[1]);
    if (!name || skills.some((skill) => skill.name === name)) continue;
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? systemPrompt.length;
    const content = systemPrompt
      .slice(start, end)
      .replace(/\r?\n[^\r\n]+ skill:\s*$/i, "")
      .trim();
    skills.push({ name, content });
  }
  return skills;
}

export function buildWorkflowBehaviorAgents(
  runDetail: WorkflowRunDetail | null,
  phases: WorkflowPhase[],
): WorkflowBehaviorAgent[] {
  const agentPhases = phases.filter(
    (phase) => (phase.kind === "agent" || phase.kind === "validator" || phase.kind === "loop") &&
      !phaseString(phase, "handoffTarget"),
  );
  const events = parseEvents(runDetail?.consoleEntries ?? []);
  const resourceDataSources = readResourceDataSources(runDetail);
  const telemetryHandoffsByAgent = new Map<string, string[]>();
  for (const phase of phases) {
    const target = phaseString(phase, "handoffTarget");
    const prompt = phaseString(phase, "prompt");
    if (!target || !prompt) continue;
    const key = normalizeName(target);
    telemetryHandoffsByAgent.set(key, [...(telemetryHandoffsByAgent.get(key) ?? []), prompt]);
  }
  const toolsByParent = new Map<string, string[]>();
  const runtimeToolsByParent = new Map<string, WorkflowBehaviorToolCall[]>();
  for (const phase of phases) {
    if (phase.kind !== "tool") continue;
    const parentKey = phaseString(phase, "parentKey");
    if (!parentKey) continue;
    toolsByParent.set(parentKey, [...(toolsByParent.get(parentKey) ?? []), phase.label]);
    const runtimeToolName = phaseString(phase, "runtimeToolName");
    if (runtimeToolName) {
      runtimeToolsByParent.set(parentKey, [
        ...(runtimeToolsByParent.get(parentKey) ?? []),
        {
          id: phaseString(phase, "runtimeToolId") ?? phase.phaseKey,
          name: runtimeToolName,
          input: phase.metadata?.runtimeToolInput ?? {},
          output: phase.metadata?.runtimeToolOutput ?? null,
          ts: phase.startedAt ? new Date(phase.startedAt).toISOString() : new Date(0).toISOString(),
        },
      ]);
    }
  }

  const agents: WorkflowBehaviorAgent[] = agentPhases.map((phase, index) => {
    const name = phaseString(phase, "agentName") ?? phase.label;
    const normalizedName = normalizeName(name);
    const telemetryHandoff = telemetryHandoffsByAgent.get(normalizedName)?.join("\n\n") ?? null;
    const ownEvents = events.filter((event) => normalizeName(event.author) === normalizedName);
    const userPromptText = ownEvents
      .filter((event) => event.role === "user")
      .flatMap((event) => event.text);
    const callRecords = ownEvents.flatMap((event) =>
      event.calls.map((call) => ({ ...call, ts: event.ts })),
    );
    const responses = ownEvents.flatMap((event) => event.responses);
    const tools: WorkflowBehaviorToolCall[] = callRecords.map((call) => {
      const response = responses.find(
        (candidate) => candidate.id === call.id || candidate.name === call.name,
      );
      return {
        id: call.id,
        name: call.name,
        input: call.input,
        output: response?.output ?? null,
        ts: call.ts,
      };
    });
    tools.push(...(runtimeToolsByParent.get(phase.phaseKey) ?? []));
    const runtimeToolName = phaseString(phase, "runtimeToolName");
    if (runtimeToolName) {
      tools.push({
        id: phaseString(phase, "runtimeToolId") ?? phase.phaseKey,
        name: runtimeToolName,
        input: phase.metadata?.runtimeToolInput ?? {},
        output: phase.metadata?.runtimeToolOutput ?? null,
        ts: phase.startedAt ? new Date(phase.startedAt).toISOString() : new Date(0).toISOString(),
      });
    }
    const isRoot = index === 0;
    const runtimePrompt = phaseString(phase, "prompt");
    // The runtime wrapper receives the workflow's top-level handoff for every
    // nested ADK agent. It is useful on the entry agent, but repeating it on
    // each downstream agent falsely suggests it is that agent's own context.
    const isWorkflowHandoff = isWorkflowHandoffPrompt(runtimePrompt);
    const displayedRuntimePrompt = !isRoot && isWorkflowHandoff ? null : runtimePrompt;
    const prompt = displayedRuntimePrompt
      ? displayedRuntimePrompt
      : telemetryHandoff
      ? telemetryHandoff
      : userPromptText.length > 0
      ? userPromptText.join("\n\n")
      : isRoot
        ? runDetail?.inputMarkdown ?? null
        : null;

    const systemPrompt = phaseString(phase, "systemPrompt");
    const skills = [...phaseSkills(phase), ...parseEmbeddedSkills(systemPrompt)]
      .filter((skill, skillIndex, all) => all.findIndex((candidate) => candidate.name === skill.name) === skillIndex);
    const service = phaseString(phase, "service");
    const finalModelEvent = [...ownEvents]
      .reverse()
      .find((event) => event.role === "model" && event.text.length > 0);
    const capturedOutput = Object.prototype.hasOwnProperty.call(phase.metadata ?? {}, "output")
      ? phase.metadata?.output ?? null
      : finalModelEvent
        ? finalModelEvent.text.join("\n\n")
        : null;
    const observedToolNames = new Set(tools.map((tool) => tool.name));
    const dataSources: WorkflowBehaviorDataSource[] = [
      ...tools.map((tool) => ({
        id: `tool-${tool.id}`,
        name: tool.name,
        kind: "tool" as const,
        status: "queried" as const,
        query: tool.input,
        outcome: tool.output,
      })),
      ...[
        ...(toolsByParent.get(phase.phaseKey) ?? []),
        ...phaseStringArray(phase, "configuredTools"),
      ]
        .filter((toolName, toolIndex, all) =>
          all.indexOf(toolName) === toolIndex && !observedToolNames.has(toolName))
        .map((toolName) => ({
          id: `configured-${phase.phaseKey}-${toolName}`,
          name: toolName,
          kind: "tool" as const,
          status: "configured" as const,
          query: null,
          outcome: null,
        })),
      ...(isRoot ? resourceDataSources : []),
    ];
    return {
      phaseKey: phase.phaseKey,
      name,
      status: phase.status,
      called: phaseHasRuntimeEvidence(phase) || ownEvents.length > 0,
      prompt,
      promptSource: displayedRuntimePrompt
        ? phaseString(phase, "service")
          ? "runtime_service"
          : isWorkflowHandoff
            ? "workflow_handoff"
          : "adk_event"
        : telemetryHandoff
          ? "telemetry_handoff"
        : userPromptText.length > 0
          ? "adk_event"
          : isRoot && prompt
            ? "run_input"
            : "unavailable",
      model: phaseString(phase, "model") ?? (service ? null : runDetail?.model ?? null),
      service,
      systemPrompt,
      output: capturedOutput,
      description: phaseString(phase, "description"),
      skills,
      tools,
      configuredTools: [
        ...(toolsByParent.get(phase.phaseKey) ?? []),
        ...phaseStringArray(phase, "configuredTools"),
      ].filter((name, toolIndex, all) => all.indexOf(name) === toolIndex),
      dataSources,
    };
  });
  const standaloneTools: WorkflowBehaviorAgent[] = [];
  const matchedCompactFallbacks = new Map<string, number>();
  for (const toolActor of buildCompactSourceServices(runDetail?.consoleEntries ?? [])) {
    const parentName = normalizeName(toolActor.parentAgentName ?? null);
    const parent = agents.find((agent) =>
      normalizeName(agent.name) === parentName || normalizeName(agent.phaseKey) === parentName,
    );
    if (!parent) {
      standaloneTools.push(toolActor);
      continue;
    }

    parent.called = true;
    const fallbackTools = toolActor.tools.filter((tool) => {
      const normalizedToolName = normalizeName(tool.name);
      const matchKey = `${parent.phaseKey}\u0000${normalizedToolName}`;
      const primaryCallCount = parent.tools.filter(
        (candidate) =>
          !candidate.id.startsWith("compact-source-call:") &&
          normalizeName(candidate.name) === normalizedToolName,
      ).length;
      const matchedCount = matchedCompactFallbacks.get(matchKey) ?? 0;
      if (matchedCount >= primaryCallCount) return true;
      matchedCompactFallbacks.set(matchKey, matchedCount + 1);
      return false;
    });
    parent.tools = [...parent.tools, ...fallbackTools].filter((tool, index, all) =>
      all.findIndex((candidate) => candidate.id === tool.id) === index,
    );
    parent.configuredTools = [...parent.configuredTools, ...toolActor.configuredTools].filter(
      (name, index, all) => all.indexOf(name) === index,
    );
    const fallbackToolIds = new Set(fallbackTools.map((tool) => tool.id));
    const fallbackDataSources = toolActor.dataSources.filter((source) =>
      fallbackToolIds.has(source.id.replace("compact-source-data:", "compact-source-call:")),
    );
    const fallbackSourceNames = new Set(
      fallbackDataSources.map((source) => normalizeName(source.name)),
    );
    parent.dataSources = [
      ...parent.dataSources.filter((source) =>
        source.kind !== "tool" ||
        source.status !== "configured" ||
        !fallbackSourceNames.has(normalizeName(source.name))),
      ...fallbackDataSources,
    ].filter(
      (source, index, all) => all.findIndex((candidate) => candidate.id === source.id) === index,
    );
  }

  return [...agents, ...standaloneTools];
}
