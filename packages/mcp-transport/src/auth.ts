/**
 * Bearer-token → binding authentication for the HTTP transport.
 *
 * The convention (ported from plugins/honcho/src/mcp/auth.ts) is that a caller
 * presents an opaque bearer token, and the server resolves that token to a JSON
 * binding stored in AWS SSM Parameter Store under `<prefix>/<token>`. The
 * binding is then mapped to a transport-specific config by the caller.
 *
 * Hardening over the honcho reference:
 *   - The token is validated against a strict URL-safe charset BEFORE it is used
 *     to build the SSM parameter name.
 *   - The `aws` CLI is invoked via execFileSync (no shell), so a token can never
 *     be interpreted as shell syntax even if validation were bypassed.
 *   - The SSM reader is injectable, so callers can supply a native SDK reader
 *     and tests can stub it.
 */
import { execFileSync } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { TokenBindingError, UnauthorizedError } from "./errors.js";

/** URL-safe token charset. Rejects anything that could carry shell/path syntax. */
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/;

/** Extract and validate the bearer token from a request's Authorization header. */
export function extractBearerToken(req: Pick<IncomingMessage, "headers">): string {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    throw new UnauthorizedError("Missing or invalid Authorization header");
  }
  const token = authHeader.substring(7).trim();
  if (!token) {
    throw new UnauthorizedError("Token is empty");
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new UnauthorizedError("Malformed token");
  }
  return token;
}

/** Reads a single decrypted SSM parameter value by name. */
export type SsmParameterReader = (paramName: string) => string;

/**
 * Default SSM reader: shells out to the `aws` CLI via execFileSync (no shell
 * interpolation). Returns the decrypted parameter value, or throws if the
 * parameter does not exist / the CLI fails.
 */
export const defaultSsmReader: SsmParameterReader = (paramName) => {
  const stdout = execFileSync(
    "aws",
    [
      "ssm",
      "get-parameter",
      "--name",
      paramName,
      "--with-decryption",
      "--query",
      "Parameter.Value",
      "--output",
      "text",
    ],
    { encoding: "utf8" },
  );
  return stdout.trim();
};

export interface SsmTokenAuthOptions<TConfig> {
  /**
   * SSM parameter path prefix. The full parameter name is `<prefix>/<token>`.
   * Trailing slashes are trimmed. E.g. "/paperclip/mcp/tokens".
   */
  paramPrefix: string;
  /**
   * Map a decoded JSON binding (and the presenting token) to a transport config.
   * Throw {@link TokenBindingError} (or any HttpError) to reject a binding that
   * is structurally invalid.
   */
  toConfig: (binding: Record<string, unknown>, token: string) => TConfig;
  /** Override the SSM reader (native SDK in prod, stub in tests). */
  readParameter?: SsmParameterReader;
}

/**
 * Build an authenticator: `(req) => TConfig`. Rejects with an
 * {@link UnauthorizedError} for a missing/malformed/unknown token and a
 * {@link TokenBindingError} for a stored binding that is not valid JSON.
 */
export function createSsmTokenAuthenticator<TConfig>(
  options: SsmTokenAuthOptions<TConfig>,
): (req: Pick<IncomingMessage, "headers">) => TConfig {
  const read = options.readParameter ?? defaultSsmReader;
  const prefix = options.paramPrefix.replace(/\/+$/, "");

  return (req) => {
    const token = extractBearerToken(req);
    const paramName = `${prefix}/${token}`;

    let raw: string;
    try {
      raw = read(paramName);
    } catch {
      // Do not leak whether the parameter exists — treat any lookup failure as
      // an invalid token.
      throw new UnauthorizedError("Unauthorized: Invalid token");
    }
    // The `aws ... --output text` CLI prints "None" for a missing value.
    if (!raw || raw === "None") {
      throw new UnauthorizedError("Unauthorized: Invalid token");
    }

    let binding: unknown;
    try {
      binding = JSON.parse(raw);
    } catch {
      throw new TokenBindingError("Invalid token binding format in SSM");
    }
    if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
      throw new TokenBindingError("Token binding must be a JSON object");
    }

    return options.toConfig(binding as Record<string, unknown>, token);
  };
}
