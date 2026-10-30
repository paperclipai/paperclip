import { execFile } from "node:child_process";

/** Public requirements use aliases; deployment profiles bind these to private references. */
export type JourneyCredentialBinding =
  | { source: "environment"; variable: string }
  | { source: "onepassword"; reference: string };

export class JourneyDependencyError extends Error {
  constructor(readonly code: "invalid_dependency_binding" | "service_account_unavailable" | "credential_unavailable") {
    super(code);
  }
}

export function parseJourneyCredentialBinding(input: unknown): JourneyCredentialBinding {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new JourneyDependencyError("invalid_dependency_binding");
  const value = input as Record<string, unknown>;
  if (value.source === "environment" && Object.keys(value).sort().join() === "source,variable"
    && typeof value.variable === "string" && /^[A-Z][A-Z0-9_]{1,100}$/.test(value.variable)
    && value.variable !== "OP_SERVICE_ACCOUNT_TOKEN") return { source: value.source, variable: value.variable };
  // Resolve one selected field, never a vault/item dump or shell expression.
  if (value.source === "onepassword" && Object.keys(value).sort().join() === "reference,source"
    && typeof value.reference === "string" && value.reference.length < 1024
    && /^op:\/\/[^/?#\s]+\/[^/?#\s]+\/(?:[^/?#\r\n]+\/)?[^/?#\r\n]+(?:\?attribute=otp)?$/.test(value.reference)
    && !/[`$\x00-\x1f]/.test(value.reference)) return { source: value.source, reference: value.reference };
  throw new JourneyDependencyError("invalid_dependency_binding");
}

export type SecretReader = (reference: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<string>;
const readOnePassword: SecretReader = (reference, env, signal) => new Promise((resolve, reject) => {
  execFile("op", ["read", "--no-newline", reference], {
    env, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, signal,
  }, (error, stdout) => {
    // CLI errors can contain private paths, item references or provider responses.
    if (error || !stdout.trim()) reject(new JourneyDependencyError("credential_unavailable"));
    else resolve(stdout);
  });
});

/** The service-account credential goes only to op, never the browser or product agent. */
export async function resolveJourneyCredential(binding: JourneyCredentialBinding, options: {
  env?: NodeJS.ProcessEnv; signal?: AbortSignal; read?: SecretReader; registerSecret(value: string): void;
}): Promise<string> {
  const checked = parseJourneyCredentialBinding(binding);
  const env = options.env ?? process.env;
  if (checked.source === "environment") {
    const value = env[checked.variable];
    if (!value?.trim()) throw new JourneyDependencyError("credential_unavailable");
    options.registerSecret(value);
    return value;
  }
  if (!env.OP_SERVICE_ACCOUNT_TOKEN?.trim()) throw new JourneyDependencyError("service_account_unavailable");
  options.registerSecret(env.OP_SERVICE_ACCOUNT_TOKEN);
  const isolatedEnv: NodeJS.ProcessEnv = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR", "LANG", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]
    .flatMap(key => env[key] ? [[key, env[key]!]] : []));
  isolatedEnv.OP_SERVICE_ACCOUNT_TOKEN = env.OP_SERVICE_ACCOUNT_TOKEN;
  try {
    const value = await (options.read ?? readOnePassword)(checked.reference, isolatedEnv, options.signal);
    if (!value.trim()) throw new JourneyDependencyError("credential_unavailable");
    options.registerSecret(value);
    return value;
  } catch { throw new JourneyDependencyError("credential_unavailable"); }
}
