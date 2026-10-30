import { lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value)
  ? value as JsonObject : {};
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const counter = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function bindCodexRolloutTurnToNativeRun(snapshot: unknown, expected: {
  runId: string; runnerInstanceId: string; normalizedSessionId: string;
}): { providerTurnId: string; nativeTurnId: string } | null {
  const state = object(snapshot);
  const control = object(state.control);
  const runner = object(state.runner);
  const committedEvents = control.committedEvents;
  const commands = control.commands;
  if (!Array.isArray(committedEvents) || !Array.isArray(commands)) return null;
  if (committedEvents.length === 0 || committedEvents.length > 100_000 ||
      !Number.isSafeInteger(runner.ackedSourceSeq) || runner.ackedSourceSeq !== committedEvents.length ||
      !Number.isSafeInteger(runner.nextSourceSeq) || runner.nextSourceSeq !== committedEvents.length + 1) return null;
  let acceptedCount = 0;
  let startedCount = 0;
  let usageCount = 0;
  let providerTurnId: string | null = null;
  let nativeTurnId: string | null = null;
  for (let index = 0; index < committedEvents.length; index++) {
    const row = object(committedEvents[index]);
    const envelope = object(row.envelope);
    const event = object(envelope.payload);
    if (envelope.runnerInstanceId !== expected.runnerInstanceId || event.runId !== expected.runId ||
        event.sourceInstanceId !== expected.runnerInstanceId || event.normalizedSessionId !== expected.normalizedSessionId ||
        event.sourceSeq !== index + 1 || typeof event.eventType !== "string") return null;
    if (event.eventType === "turn.accepted") acceptedCount++;
    if (event.eventType === "turn.started") {
      startedCount++;
      const candidate = text(object(event.payload).providerTurnId);
      const eventTurnId = text(event.turnId);
      if (!candidate || !eventTurnId) return null;
      providerTurnId = candidate;
      nativeTurnId = eventTurnId;
    }
    if (event.eventType === "usage.reported") {
      usageCount++;
      if (!nativeTurnId || event.turnId !== nativeTurnId) return null;
    }
    if (["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted", "run.result.proposed", "run.terminal"].includes(event.eventType)) return null;
  }
  const starts = commands.filter(command => object(command).type === "turn.start");
  if (acceptedCount > 1 || startedCount !== 1 || usageCount === 0 || starts.length !== 1 ||
      object(starts[0]).status !== "completed" ||
      object(object(object(starts[0]).result).result).providerTurnId !== providerTurnId || !providerTurnId || !nativeTurnId) return null;
  return { providerTurnId, nativeTurnId };
}

export function findCodexRolloutCandidate(root: string, threadId: string): string | null {
  try {
    if (!threadId) return null;
    const codexHome = resolve(root, "codex-home");
    const sessions = resolve(codexHome, "sessions");
    for (const directory of [root, codexHome, sessions]) {
      const info = lstatSync(directory, { throwIfNoEntry: false });
      if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    }
    let visited = 0;
    let years: string[];
    try { years = readdirSync(sessions); } catch { return null; }
    visited += years.length;
    if (visited > 10_000) return null;
    const candidates: string[] = [];
    for (const year of years) {
      const yearPath = resolve(sessions, year);
      const yearInfo = lstatSync(yearPath, { throwIfNoEntry: false });
      if (!yearInfo || yearInfo.isSymbolicLink()) return null;
      if (!yearInfo.isDirectory() || !/^\d{4}$/.test(year)) continue;
      let months: string[];
      try { months = readdirSync(yearPath); } catch { return null; }
      visited += months.length;
      if (visited > 10_000) return null;
      for (const month of months) {
        const monthPath = resolve(yearPath, month);
        const monthInfo = lstatSync(monthPath, { throwIfNoEntry: false });
        if (!monthInfo || monthInfo.isSymbolicLink()) return null;
        if (!monthInfo.isDirectory() || !/^\d{2}$/.test(month)) continue;
        let days: string[];
        try { days = readdirSync(monthPath); } catch { return null; }
        visited += days.length;
        if (visited > 10_000) return null;
        for (const day of days) {
          const dayPath = resolve(monthPath, day);
          const dayInfo = lstatSync(dayPath, { throwIfNoEntry: false });
          if (!dayInfo || dayInfo.isSymbolicLink()) return null;
          if (!dayInfo.isDirectory() || !/^\d{2}$/.test(day)) continue;
          let names: string[];
          try { names = readdirSync(dayPath); } catch { return null; }
          visited += names.length;
          if (visited > 10_000) return null;
          for (const name of names) {
            const file = resolve(dayPath, name);
            const info = lstatSync(file, { throwIfNoEntry: false });
            if (!info || info.isSymbolicLink()) return null;
            if (info.isFile() && name.startsWith("rollout-") && name.endsWith(`-${threadId}.jsonl`)) {
              if (info.size > 32 * 1024 * 1024) return null;
              candidates.push(file);
            }
          }
        }
      }
    }
    return candidates.length === 1 ? candidates[0]! : null;
  } catch { return null; }
}

export type CodexRolloutTurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
};

export function parseCodexRolloutTurnUsage(input: string, expected: { threadId: string; turnId: string }): CodexRolloutTurnUsage | null {
  if (!expected.threadId || !expected.turnId || input.length === 0 || !input.endsWith("\n")) return null;
  const lines = input.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > 100_000) return null;
  let sessionMetadataCount = 0;
  let sessionMatches = false;
  let rootSessionId: string | null = null;
  const starts: Array<{ ordinal: number; turnId: string; rootTurnId: string }> = [];
  const terminals: Array<{ ordinal: number; turnId: string; type: string }> = [];
  const records: Array<{ ordinal: number; responseId: string; usage: CodexRolloutTurnUsage; totalTokens: number; delta: CodexRolloutTurnUsage }> = [];
  const responseIds = new Set<string>();

  for (let index = 0; index < lines.length; index++) {
    let row: JsonObject;
    try { row = object(JSON.parse(lines[index]!)); } catch { return null; }
    const ordinal = row.ordinal;
    if (!Number.isSafeInteger(ordinal) || ordinal !== index) return null;
    const type = row.type;
    const payload = object(row.payload);
    if (type === "session_meta") {
      sessionMetadataCount++;
      if (index !== 0) return null;
      const sessionId = text(payload.session_id);
      if (payload.id === expected.threadId && sessionId) {
        sessionMatches = true;
        rootSessionId = sessionId;
      }
      continue;
    }
    if (type === "event_msg") {
      const eventType = payload.type;
      const turnId = text(payload.turn_id);
      if (["task_complete", "turn_aborted"].includes(String(eventType)) && !turnId) return null;
      const rootTurnId = text(payload.root_turn_id) ?? (payload.root_turn_id === undefined || payload.root_turn_id === null ? turnId : null);
      if (turnId === expected.turnId && eventType === "task_started" && rootTurnId) starts.push({ ordinal, turnId, rootTurnId });
      if (turnId === expected.turnId && ["task_complete", "turn_aborted"].includes(String(eventType))) {
        terminals.push({ ordinal, turnId, type: String(eventType) });
      }
      continue;
    }
    if (type !== "token_usage_record") continue;
    if (payload.thread_id !== expected.threadId || !text(payload.turn_id)) return null;
    const sessionId = text(payload.session_id);
    if (!sessionId || sessionId !== rootSessionId) return null;
    if (payload.turn_id !== expected.turnId) continue;
    const rootTurnId = text(payload.root_turn_id);
    const responseId = text(payload.response_id);
    const aggregate = object(payload.turn_token_usage);
    const responseUsage = object(payload.usage);
    const inputTokens = counter(aggregate.input_tokens);
    const outputTokens = counter(aggregate.output_tokens);
    const cachedInputTokens = counter(aggregate.cached_input_tokens);
    const cacheWriteTokens = counter(aggregate.cache_write_input_tokens) ?? 0;
    const totalTokens = counter(aggregate.total_tokens);
    const responseInput = counter(responseUsage.input_tokens);
    const responseOutput = counter(responseUsage.output_tokens);
    const responseCached = counter(responseUsage.cached_input_tokens);
    const responseCacheWrite = responseUsage.cache_write_input_tokens === undefined ? 0 : counter(responseUsage.cache_write_input_tokens);
    const responseTotal = counter(responseUsage.total_tokens);
    if (rootTurnId !== starts[0]?.rootTurnId || !responseId ||
        inputTokens === null || outputTokens === null || totalTokens === null ||
        (aggregate.cached_input_tokens !== undefined && counter(aggregate.cached_input_tokens) === null) ||
        (aggregate.cache_write_input_tokens !== undefined && counter(aggregate.cache_write_input_tokens) === null) ||
        responseInput === null || responseOutput === null || responseCached === null || responseCacheWrite === null || responseTotal === null ||
        responseCached > responseInput || responseCacheWrite > responseInput || responseTotal !== responseInput + responseOutput ||
        cachedInputTokens === null || cacheWriteTokens > inputTokens || cachedInputTokens > inputTokens || totalTokens !== inputTokens + outputTokens ||
        responseIds.has(responseId)) return null;
    responseIds.add(responseId);
    records.push({ ordinal, responseId, usage: { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens }, totalTokens,
      delta: { inputTokens: responseInput, outputTokens: responseOutput, cachedInputTokens: responseCached, cacheWriteTokens: responseCacheWrite } });
  }

  if (sessionMetadataCount !== 1 || !sessionMatches || starts.length !== 1 || starts[0]!.turnId !== expected.turnId ||
      terminals.length !== 1 || terminals[0]!.turnId !== expected.turnId || terminals[0]!.type !== "turn_aborted" ||
      records.length === 0 || records[0]!.ordinal <= starts[0]!.ordinal ||
      records.some(record => record.ordinal >= terminals[0]!.ordinal)) return null;

  const observed: CodexRolloutTurnUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  for (let index = 0; index < records.length; index++) {
    const currentRecord = records[index]!;
    for (const key of Object.keys(observed) as Array<keyof CodexRolloutTurnUsage>) observed[key] += currentRecord.delta[key];
    if (Object.keys(observed).some(key => observed[key as keyof CodexRolloutTurnUsage] !== currentRecord.usage[key as keyof CodexRolloutTurnUsage]) ||
        currentRecord.totalTokens !== observed.inputTokens + observed.outputTokens) return null;
  }
  for (let index = 1; index < records.length; index++) {
    const prior = records[index - 1]!.usage;
    const current = records[index]!.usage;
    if (current.inputTokens < prior.inputTokens || current.outputTokens < prior.outputTokens ||
        current.cachedInputTokens < prior.cachedInputTokens || current.cacheWriteTokens < prior.cacheWriteTokens) return null;
  }
  return records.at(-1)!.usage;
}
