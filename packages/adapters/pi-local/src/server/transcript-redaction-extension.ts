const REDACTED_VALUE = "***REDACTED***";
const EXTRA_SECRET_ENV_KEYS = "PAPERCLIP_TRANSCRIPT_SECRET_ENV_KEYS";
const SENSITIVE_ENV_KEY_RE =
  /(api_?key|access_?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private_?key|cookie|connectionstring)/i;

type ToolResultEvent = {
  content: unknown;
  details?: unknown;
};

type PiExtensionApi = {
  on(event: "tool_result", handler: (event: ToolResultEvent) => { content: unknown; details?: unknown }): void;
};

function parseExtraSecretEnvKeys(env: NodeJS.ProcessEnv): string[] {
  const raw = env[EXTRA_SECRET_ENV_KEYS];
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export function collectTranscriptSecretValues(env: NodeJS.ProcessEnv): string[] {
  const secretKeys = new Set([
    ...Object.keys(env).filter((key) => SENSITIVE_ENV_KEY_RE.test(key)),
    ...parseExtraSecretEnvKeys(env),
  ]);

  return [...secretKeys]
    .map((key) => env[key])
    .filter((value): value is string => typeof value === "string" && value.length >= 4)
    .sort((left, right) => right.length - left.length);
}

function redactString(value: string, secretValues: string[]): string {
  let redacted = value;
  for (const secret of secretValues) {
    redacted = redacted.split(secret).join(REDACTED_VALUE);
  }
  return redacted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function redactTranscriptValue<T>(value: T, secretValues: string[]): T {
  if (typeof value === "string") return redactString(value, secretValues) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => redactTranscriptValue(entry, secretValues)) as T;
  }
  if (!isPlainObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactTranscriptValue(entry, secretValues)]),
  ) as T;
}

export default function transcriptRedactionExtension(pi: PiExtensionApi): void {
  const secretValues = collectTranscriptSecretValues(process.env);
  if (secretValues.length === 0) return;

  // Pi applies tool_result patches before emitting and persisting the final tool message.
  pi.on("tool_result", (event) => ({
    content: redactTranscriptValue(event.content, secretValues),
    ...(event.details === undefined
      ? {}
      : { details: redactTranscriptValue(event.details, secretValues) }),
  }));
}
