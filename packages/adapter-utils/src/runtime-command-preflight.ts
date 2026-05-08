export interface RuntimeCommandPreflightViolation {
  code: "broad_runtime_env_inspection";
  reason: string;
  safeMessage: string;
}

export const RUNTIME_COMMAND_PREFLIGHT_REFUSAL_MESSAGE = [
  "[paperclip] Runtime command refused before execution.",
  "Broad environment inspection commands are blocked to keep runtime credentials out of transcripts and logs.",
  "Use Paperclip heartbeat context, issue context, safe API metadata, or redacted/synthetic sentinel evidence instead.",
].join(" ");

const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const PROC_ENVIRON_RE = /(?:^|[\s"'`<>=:])\/proc\/(?:self|\d+|[A-Za-z0-9_.-]+)\/environ(?:$|[\s"'`>;&|])/;

function commandBasename(command: string): string {
  const normalized = command.trim().replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.toLowerCase();
}

function hasProcEnvironRead(value: string): boolean {
  return PROC_ENVIRON_RE.test(value);
}

function envCommandChild(args: string[]): { command: string; args: string[] } | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      return args[index + 1]
        ? { command: args[index + 1]!, args: args.slice(index + 2) }
        : null;
    }
    if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") {
      index += 1;
      continue;
    }
    if (arg === "-S" || arg === "--split-string") {
      return firstCommandWord(shellWords(args[index + 1] ?? ""));
    }
    if (arg.startsWith("--split-string=")) {
      return firstCommandWord(shellWords(arg.slice("--split-string=".length)));
    }
    if (arg.startsWith("--unset=") || arg.startsWith("--chdir=")) continue;
    if (arg.startsWith("-")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(arg)) continue;
    return { command: arg, args: args.slice(index + 1) };
  }
  return null;
}

function isShellCommand(command: string): boolean {
  return SHELL_COMMANDS.has(commandBasename(command));
}

function extractShellScriptArg(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-c" || (arg.endsWith("c") && /^-[A-Za-z]*c$/.test(arg))) {
      return args[index + 1] ?? "";
    }
  }
  return null;
}

function splitShellSegments(script: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    const next = script[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      current += char;
      quote = char;
      continue;
    }
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    if (char === "|" || char === ";" || char === "\n") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function firstCommandWord(words: string[]): { command: string; args: string[] } | null {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[index]!)) {
    index += 1;
  }
  const command = words[index];
  if (!command) return null;
  return { command, args: words.slice(index + 1) };
}

function violation(reason: string): RuntimeCommandPreflightViolation {
  return {
    code: "broad_runtime_env_inspection",
    reason,
    safeMessage: RUNTIME_COMMAND_PREFLIGHT_REFUSAL_MESSAGE,
  };
}

function inspectCommandWords(command: string, args: string[]): RuntimeCommandPreflightViolation | null {
  const base = commandBasename(command);
  if (base === "printenv") {
    return violation("printenv can expose runtime environment values");
  }
  if (base === "env") {
    const child = envCommandChild(args);
    if (!child) {
      return violation("env without a child command dumps the runtime environment");
    }
    return detectRuntimeCommandPreflightViolation(child);
  }
  if (base === "set" && (args.length === 0 || !/^[+-]/.test(args[0] ?? ""))) {
    return violation("bare shell set dumps shell variables and environment-derived values");
  }
  if (base === "export" && (args.length === 0 || args.includes("-p"))) {
    return violation("bare shell export dumps exported runtime variables");
  }
  return null;
}

function inspectShellScript(script: string): RuntimeCommandPreflightViolation | null {
  if (hasProcEnvironRead(script)) {
    return violation("/proc/*/environ reads expose runtime environment values");
  }
  for (const segment of splitShellSegments(script)) {
    const words = shellWords(segment);
    const command = firstCommandWord(words);
    if (!command) continue;
    const direct = inspectCommandWords(command.command, command.args);
    if (direct) return direct;
  }
  return null;
}

export function detectRuntimeCommandPreflightViolation(input: {
  command: string;
  args?: string[];
}): RuntimeCommandPreflightViolation | null {
  const args = input.args ?? [];
  const commandText = [input.command, ...args].join(" ");
  if (hasProcEnvironRead(commandText)) {
    return violation("/proc/*/environ reads expose runtime environment values");
  }

  const shellScript = isShellCommand(input.command) ? extractShellScriptArg(args) : null;
  if (shellScript !== null) {
    return inspectShellScript(shellScript);
  }

  return inspectCommandWords(input.command, args);
}

export function isRuntimeCommandPreflightViolation(error: unknown): error is Error & {
  runtimeCommandPreflightViolation: RuntimeCommandPreflightViolation;
} {
  return Boolean(
    error
      && typeof error === "object"
      && "runtimeCommandPreflightViolation" in error,
  );
}

export function runtimeCommandPreflightError(
  violation: RuntimeCommandPreflightViolation,
): Error & { runtimeCommandPreflightViolation: RuntimeCommandPreflightViolation } {
  const error = new Error(violation.safeMessage) as Error & {
    runtimeCommandPreflightViolation: RuntimeCommandPreflightViolation;
  };
  error.name = "RuntimeCommandPreflightError";
  error.runtimeCommandPreflightViolation = violation;
  return error;
}
