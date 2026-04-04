import path from "node:path";
import { ensureCommandResolvable } from "@paperclipai/adapter-utils/server-utils";

export type CursorInvocationKind = "standalone_agent" | "cursor_subcommand" | "custom";

export type CursorCommandCandidate = {
  command: string;
  invocationKind: CursorInvocationKind;
  baseArgs: string[];
};

type ResolveCursorCommandInput = {
  configuredCommand: string | null | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
  ensureResolvable?: (
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<void>;
};

const MAC_CURSOR_APP_COMMANDS = [
  "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
  "/Applications/Cursor EAP.app/Contents/Resources/app/bin/cursor",
] as const;

function commandBasename(command: string): string {
  return path.basename(command.trim()).toLowerCase();
}

function isLegacyAgentCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const base = commandBasename(trimmed);
  if (base !== "agent" && base !== "agent.cmd" && base !== "agent.exe") return false;
  return !trimmed.includes("/") && !trimmed.includes("\\");
}

export function classifyCursorCommand(command: string): Omit<CursorCommandCandidate, "command"> {
  const base = commandBasename(command);
  if (base === "cursor" || base === "cursor.cmd" || base === "cursor.exe") {
    return {
      invocationKind: "cursor_subcommand",
      baseArgs: ["agent"],
    };
  }
  if (base === "agent" || base === "agent.cmd" || base === "agent.exe") {
    return {
      invocationKind: "standalone_agent",
      baseArgs: [],
    };
  }

  return {
    invocationKind: "custom",
    baseArgs: [],
  };
}

export function buildCursorCommandCandidates(configuredCommand: string | null | undefined): CursorCommandCandidate[] {
  const trimmed = configuredCommand?.trim() ?? "";
  if (trimmed && !isLegacyAgentCommand(trimmed)) {
    return [{ command: trimmed, ...classifyCursorCommand(trimmed) }];
  }

  return ["agent", "cursor", ...MAC_CURSOR_APP_COMMANDS].map((command) => ({
    command,
    ...classifyCursorCommand(command),
  }));
}

export function describeCursorCommand(candidate: Pick<CursorCommandCandidate, "command" | "baseArgs">): string {
  return [candidate.command, ...candidate.baseArgs].join(" ");
}

export function cursorLoginCommand(candidate: Pick<CursorCommandCandidate, "command" | "baseArgs">): string {
  return describeCursorCommand({
    command: candidate.command,
    baseArgs: [...candidate.baseArgs, "login"],
  });
}

export async function resolveCursorCommand(input: ResolveCursorCommandInput): Promise<CursorCommandCandidate> {
  const ensureResolvable = input.ensureResolvable ?? ensureCommandResolvable;
  const candidates = buildCursorCommandCandidates(input.configuredCommand);
  let firstError: unknown = null;

  for (const candidate of candidates) {
    try {
      await ensureResolvable(candidate.command, input.cwd, input.env);
      return candidate;
    } catch (err) {
      if (firstError == null) firstError = err;
    }
  }

  if (firstError instanceof Error) throw firstError;
  throw new Error("Unable to resolve a Cursor CLI command");
}
