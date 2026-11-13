import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join } from "node:path";

/**
 * Output custody keeps the exact values of configured secrets out of what
 * OpenCode captures from tools. OpenCode stores captured tool output in its
 * session database (including streamed previews written while a command still
 * runs) and sends it to the model, so redacting after capture is too late.
 *
 * Two layers run inside OpenCode, before any byte is captured:
 * - Commands: OpenCode's configured shell is a small POSIX wrapper. It runs the
 *   shell OpenCode would have used and passes all of its output through an awk
 *   filter that replaces exact secret values, so OpenCode only reads filtered
 *   output.
 * - Other tools (file reads, searches, MCP results): a local plugin rewrites
 *   the completed result in `tool.execute.after`, which OpenCode runs before it
 *   persists or returns that result.
 *
 * The wrapper fails closed: it runs nothing unless the plugin has started for
 * this launch, so no command can write a secret to a file that a later file
 * read would return unfiltered. Values never touch disk here: the wrapper,
 * filter and plugin read them from the environment OpenCode already holds.
 */

/** Shorter values are not redacted: they cannot be told apart from ordinary text. */
export const OUTPUT_CUSTODY_MIN_VALUE_LENGTH = 4;
export const OUTPUT_CUSTODY_REDACTION = "[REDACTED]";

export const OUTPUT_CUSTODY_KEYS_ENV = "PAPERCLIP_OUTPUT_CUSTODY_KEYS";
export const OUTPUT_CUSTODY_NONCE_ENV = "PAPERCLIP_OUTPUT_CUSTODY_NONCE";
export const OUTPUT_CUSTODY_DIRECTORY_ENV = "PAPERCLIP_OUTPUT_CUSTODY_DIR";

export class OutputCustodyUnavailableError extends Error {
  readonly code = "opencode_output_custody_unavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "OutputCustodyUnavailableError";
  }
}

export interface OpenCodeOutputCustody {
  /** OpenCode configuration entries. */
  config: { shell: string; plugin: string[] };
  /** Environment for the OpenCode process. Names and a per-launch nonce only. */
  environment: Record<string, string>;
  /** Exact strings removed from output, longest first. */
  values: string[];
}

/** The exact strings to remove for each secret value: the value and each line of a multi-line value. */
export function outputCustodyValues(values: readonly string[]): string[] {
  const result = new Set<string>();
  for (const value of values) {
    for (const candidate of [value, ...value.split("\n").map(line => line.replace(/\r$/, ""))]) {
      if (candidate.length >= OUTPUT_CUSTODY_MIN_VALUE_LENGTH) result.add(candidate);
    }
  }
  return [...result].sort((left, right) => right.length - left.length || (left < right ? -1 : 1));
}

/** Replace every exact secret value in text. */
export function redactOutputCustodyText(text: string, values: readonly string[]): string {
  let result = text;
  for (const value of values) if (result.includes(value)) result = result.split(value).join(OUTPUT_CUSTODY_REDACTION);
  return result;
}

/**
 * Command output is filtered line by line, so a secret is protected there
 * through its lines of at least the minimum length (a single-line value is its
 * own line). A value with no such line cannot be told apart from ordinary
 * output and is refused rather than left unprotected.
 */
export function assertOutputCustodyProtects(values: readonly string[]): void {
  for (const value of values) {
    const lines = value.split("\n").map(line => line.replace(/\r$/, ""));
    if (value.length > 0 && !lines.some(line => line.length >= OUTPUT_CUSTODY_MIN_VALUE_LENGTH)) {
      throw new OutputCustodyUnavailableError(
        `A configured secret is too short to keep out of agent output; use a value of at least ${OUTPUT_CUSTODY_MIN_VALUE_LENGTH} characters.`,
      );
    }
  }
}

/**
 * Remove exact secret values from the string values of a parsed model request
 * and serialize it again. Field names and non-string values are never touched,
 * so the request keeps its structure. Returns null when no string holds a
 * value: a cheap byte scan for each value's raw and JSON-escaped spelling
 * keeps the common path to the original bytes.
 */
export function redactOpenCodeModelRequest(body: Buffer, values: readonly string[], payload?: unknown) {
  if (!values.some(value => body.includes(value) || body.includes(JSON.stringify(value).slice(1, -1)))) return null;
  const parsed = payload ?? JSON.parse(body.toString("utf8"));
  let changed = false;
  const visit = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") {
      const redacted = redactOutputCustodyText(node, values);
      if (redacted !== node) changed = true;
      return redacted;
    }
    if (!node || typeof node !== "object" || depth > 256) return node;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) node[index] = visit(node[index], depth + 1);
    } else {
      for (const key of Object.keys(node)) (node as Record<string, unknown>)[key] = visit((node as Record<string, unknown>)[key], depth + 1);
    }
    return node;
  };
  const result = visit(parsed, 0);
  return changed ? Buffer.from(JSON.stringify(result), "utf8") : null;
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutable(name: string, environment: NodeJS.ProcessEnv, fallbacks: readonly string[] = []): string | null {
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (executable(candidate)) return candidate;
  }
  return fallbacks.find(executable) ?? null;
}

/**
 * The shell OpenCode selects when none is configured (its environment has no
 * SHELL): zsh on macOS, otherwise the first bash on PATH, otherwise sh.
 */
export function openCodeDefaultShell(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin" && executable("/bin/zsh")) return "/bin/zsh";
  return findExecutable("bash", environment) ?? "/bin/sh";
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** POSIX awk: exact, non-regex replacement; values come from ENVIRON only. */
export const OUTPUT_CUSTODY_AWK = `BEGIN {
  end = ENVIRON["PAPERCLIP_OUTPUT_CUSTODY_END"]
  n = split(ENVIRON["${OUTPUT_CUSTODY_KEYS_ENV}"], keys, " ")
  count = 0
  for (i = 1; i <= n; i++) {
    value = ENVIRON[keys[i]]
    if (length(value) >= ${OUTPUT_CUSTODY_MIN_VALUE_LENGTH}) { count++; vals[count] = value }
    m = split(value, parts, "\\n")
    for (j = 1; m > 1 && j <= m; j++) {
      part = parts[j]
      sub(/\\r$/, "", part)
      if (length(part) >= ${OUTPUT_CUSTODY_MIN_VALUE_LENGTH}) { count++; vals[count] = part }
    }
  }
  for (i = 2; i <= count; i++) {
    v = vals[i]; j = i - 1
    while (j > 0 && length(vals[j]) < length(v)) { vals[j + 1] = vals[j]; j-- }
    vals[j + 1] = v
  }
}
function redact(line,   i, s, out, k) {
  for (i = 1; i <= count; i++) {
    s = vals[i]; out = ""
    while ((k = index(line, s)) > 0) { out = out substr(line, 1, k - 1) "${OUTPUT_CUSTODY_REDACTION}"; line = substr(line, k + length(s)) }
    line = out line
  }
  return line
}
{
  k = length($0) - length(end)
  if (length(end) > 0 && k >= 0 && substr($0, k + 1) == end) {
    if (k > 0) printf "%s", redact(substr($0, 1, k))
    fflush()
    exit 0
  }
  print redact($0)
  fflush()
}
`;

/**
 * POSIX sh wrapper. Output written after the real shell exits is dropped, as
 * OpenCode itself stops reading at exit: the end marker stops the filter, so a
 * background process cannot hold the command open. The launch directory comes
 * from the environment so the executable stays byte-identical across launches
 * (macOS assesses each newly written executable on its first run, which costs
 * over 100 ms).
 */
export function outputCustodyWrapper(input: { realShell: string; awk: string; mkfifo: string; remove: string; filter: string }): string {
  return `#!/bin/sh
dir=\${${OUTPUT_CUSTODY_DIRECTORY_ENV}:-}
expected=
[ -n "$dir" ] && [ -f "$dir/ready" ] && IFS= read -r expected < "$dir/ready"
if [ -z "$dir" ] || [ -z "\${${OUTPUT_CUSTODY_NONCE_ENV}:-}" ] || [ "$expected" != "$${OUTPUT_CUSTODY_NONCE_ENV}" ]; then
  echo "Paperclip did not run this command because secret output protection is not active." >&2
  exit 126
fi
fifo="$dir/out.$$"
${quote(input.remove)} -f "$fifo"
${quote(input.mkfifo)} -m 600 "$fifo" || exit 126
end="PAPERCLIP-OUTPUT-END-$${OUTPUT_CUSTODY_NONCE_ENV}-$$"
PAPERCLIP_OUTPUT_CUSTODY_END="$end" ${quote(input.awk)} -f ${quote(input.filter)} < "$fifo" &
filter=$!
exec 3> "$fifo"
${quote(input.remove)} -f "$fifo"
${quote(input.realShell)} "$@" >&3 2>&3 3>&-
code=$?
printf '%s\\n' "$end" >&3
exec 3>&-
wait "$filter"
exit "$code"
`;
}

/** OpenCode plugin. Loaded by OpenCode itself; reads values from its own environment. */
export const OUTPUT_CUSTODY_PLUGIN = `import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const PaperclipOutputCustody = async () => {
  const env = process.env;
  const values = new Set();
  for (const key of String(env.${OUTPUT_CUSTODY_KEYS_ENV} ?? "").split(" ").filter(Boolean)) {
    const value = String(env[key] ?? "");
    for (const candidate of [value, ...value.split("\\n").map((line) => line.replace(/\\r$/, ""))]) {
      if (candidate.length >= ${OUTPUT_CUSTODY_MIN_VALUE_LENGTH}) values.add(candidate);
    }
  }
  const ordered = [...values].sort((left, right) => right.length - left.length);
  const redact = (text) => {
    for (const value of ordered) if (text.includes(value)) text = text.split(value).join(${JSON.stringify(OUTPUT_CUSTODY_REDACTION)});
    return text;
  };
  const visit = (value, depth) => {
    if (!value || typeof value !== "object" || depth > 64) return;
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (typeof item === "string") value[key] = redact(item);
      else visit(item, depth + 1);
    }
  };
  writeFileSync(join(String(env.${OUTPUT_CUSTODY_DIRECTORY_ENV}), "ready"), String(env.${OUTPUT_CUSTODY_NONCE_ENV} ?? ""), { mode: 0o600 });
  return {
    "tool.execute.after": async (_input, output) => { visit(output, 0); },
  };
};
`;

/** Write a file once; concurrent launches converge on the same bytes through an atomic rename. */
async function writeStable(path: string, content: string, mode: number): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === content) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, content, { mode });
  await rename(temporary, path);
}

/**
 * Prepare output custody for one OpenCode launch, or return null when no
 * configured secret needs it. `directory` must be fresh for this launch;
 * `binDirectory` is stable across launches and holds the executable wrapper.
 * `configDirectory` is OpenCode's global config directory: OpenCode waits for
 * a dependency install there before it loads any plugin, so it is marked as
 * already installed to keep that install off the first tool call.
 */
export async function prepareOpenCodeOutputCustody(input: {
  directory: string;
  binDirectory: string;
  configDirectory: string;
  environment: NodeJS.ProcessEnv;
  secrets: ReadonlyArray<{ name: string; value: string }>;
  platform?: NodeJS.Platform;
}): Promise<OpenCodeOutputCustody | null> {
  const secrets = input.secrets.filter(secret => input.environment[secret.name] === secret.value);
  assertOutputCustodyProtects(secrets.map(secret => secret.value));
  const values = outputCustodyValues(secrets.map(secret => secret.value));
  if (values.length === 0) return null;
  const awk = findExecutable("awk", input.environment, ["/usr/bin/awk", "/bin/awk"]);
  const mkfifo = findExecutable("mkfifo", input.environment, ["/usr/bin/mkfifo", "/bin/mkfifo"]);
  const remove = findExecutable("rm", input.environment, ["/bin/rm", "/usr/bin/rm"]);
  if (!awk || !mkfifo || !remove) {
    throw new OutputCustodyUnavailableError("Secret output protection needs awk, mkfifo and rm on this computer.");
  }
  const realShell = openCodeDefaultShell(input.environment, input.platform);
  const wrapperFor = (filter: string) => outputCustodyWrapper({ realShell, awk, mkfifo, remove, filter });
  const identity = createHash("sha256").update(OUTPUT_CUSTODY_AWK).update("\0").update(wrapperFor("")).digest("hex").slice(0, 24);
  const bin = join(input.binDirectory, identity);
  const filter = join(bin, "redact.awk");
  // Named like the real shell so OpenCode applies the same shell semantics.
  const shell = join(bin, basename(realShell));
  const plugin = join(input.directory, "paperclip-output-custody.js");
  await Promise.all([
    mkdir(bin, { recursive: true, mode: 0o700 }),
    mkdir(input.directory, { recursive: true, mode: 0o700 }),
    mkdir(join(input.configDirectory, "node_modules"), { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    writeStable(filter, OUTPUT_CUSTODY_AWK, 0o600),
    writeStable(shell, wrapperFor(filter), 0o700),
    writeFile(plugin, OUTPUT_CUSTODY_PLUGIN, { mode: 0o600 }),
    writeFile(
      join(input.configDirectory, "package-lock.json"),
      `${JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { "@opencode-ai/plugin": "*" } } } })}\n`,
      { mode: 0o600, flag: "wx" },
    ).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; }),
  ]);
  return {
    config: { shell, plugin: [`file://${plugin}`] },
    environment: {
      [OUTPUT_CUSTODY_KEYS_ENV]: secrets.map(secret => secret.name).join(" "),
      [OUTPUT_CUSTODY_NONCE_ENV]: randomBytes(16).toString("hex"),
      [OUTPUT_CUSTODY_DIRECTORY_ENV]: input.directory,
    },
    values,
  };
}
