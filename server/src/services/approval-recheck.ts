import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const commandProbeSchema = z.object({
  kind: z.literal("command"),
  command: z.array(z.string().trim().min(1).max(1024)).min(1).max(32),
  expectedExitCode: z.number().int().min(0).max(255),
  timeoutMs: z.number().int().min(1).max(30_000).optional().default(5_000),
}).strict();

const apiProbeSchema = z.object({
  kind: z.literal("api"),
  url: z.string().url().refine((url) => new URL(url).protocol === "https:", "API probes must use HTTPS"),
  expectedStatus: z.number().int().min(100).max(599),
  timeoutMs: z.number().int().min(1).max(30_000).optional().default(5_000),
}).strict();

export const machineRecheckPredicateSchema = z.object({
  kind: z.literal("machine"),
  probe: z.discriminatedUnion("kind", [commandProbeSchema, apiProbeSchema]),
}).strict();

export const humanJudgementDeclarationSchema = z.object({
  kind: z.literal("human_judgement"),
  declaration: z.string().trim().min(1).max(4_000),
  humanTrigger: z.string().trim().min(1).max(255),
}).strict();

export type MachineRecheckPredicate = z.infer<typeof machineRecheckPredicateSchema>;
export type MachineRecheckPredicateInput = z.input<typeof machineRecheckPredicateSchema>;

export function parseBoardAskCondition(payload: Record<string, unknown>) {
  const machine = machineRecheckPredicateSchema.safeParse(payload.recheckPredicate);
  if (machine.success) return machine.data;

  const human = humanJudgementDeclarationSchema.safeParse(payload.humanJudgement);
  if (human.success) return human.data;

  return null;
}

export function validateBoardAskCondition(payload: Record<string, unknown>) {
  const machine = machineRecheckPredicateSchema.safeParse(payload.recheckPredicate);
  const human = humanJudgementDeclarationSchema.safeParse(payload.humanJudgement);
  if (machine.success !== human.success) return;

  return "request_board_approval requires exactly one of recheckPredicate (machine condition) or humanJudgement (declaration plus named humanTrigger)";
}

export type MachineProbeResult = {
  cleared: boolean;
  note: string;
};

/**
 * Run a machine predicate without a shell. A non-matching exit code disproves
 * the condition that made the ask necessary, so the ask is safe to retire.
 */
export async function evaluateMachineRecheckPredicate(
  predicate: MachineRecheckPredicateInput,
): Promise<MachineProbeResult> {
  const resolved = machineRecheckPredicateSchema.parse(predicate);
  if (resolved.probe.kind === "api") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), resolved.probe.timeoutMs);
    let actualStatus = -1;
    try {
      const response = await fetch(resolved.probe.url, { signal: controller.signal, redirect: "manual" });
      actualStatus = response.status;
    } catch {
      // The unavailable endpoint is disproof that the expected green API state remains.
    } finally {
      clearTimeout(timeout);
    }
    const cleared = actualStatus !== resolved.probe.expectedStatus;
    return {
      cleared,
      note: `Machine-condition recheck disproof: API probe ${resolved.probe.url} returned ${actualStatus}; expected green status ${resolved.probe.expectedStatus}.`,
    };
  }

  const [file, ...args] = resolved.probe.command;
  let actualExitCode = 0;
  try {
    await execFileAsync(file, args, {
      timeout: resolved.probe.timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024,
    });
  } catch (error: any) {
    actualExitCode = typeof error?.code === "number" ? error.code : -1;
  }

  const cleared = actualExitCode !== resolved.probe.expectedExitCode;
  const command = [file, ...args].map((part) => JSON.stringify(part)).join(" ");
  return {
    cleared,
    note: `Machine-condition recheck disproof: command ${command} exited ${actualExitCode}; expected green exit ${resolved.probe.expectedExitCode}.`,
  };
}
