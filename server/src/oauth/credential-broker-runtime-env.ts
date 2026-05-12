import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Materialize the credential broker's session CA to a temporary file
 * and produce the env additions the spawned agent process needs to
 * route HTTPS traffic through the broker.
 *
 * Used by `resolveExecutionRunAdapterConfig` after the resolver minted
 * a session: the returned env map is merged into the adapter's
 * runtime env so every language runtime's HTTP client trusts the
 * per-session CA AND uses the broker as its HTTPS_PROXY.
 *
 * Cleanup: the file lives in a per-session mkdtemp under the OS temp
 * directory. Today nothing explicitly removes it — sessions are
 * bounded by TTL on the broker side and the OS rotates `/tmp`
 * eventually. A future revokeSession-driven cleanup hook is tracked
 * as a follow-up.
 */

export interface BrokerRuntimeEnvInput {
  proxyUrl: string;
  caCertPem: string;
  sessionToken: string;
}

export interface BrokerRuntimeEnv {
  /** Path the CA was written to (already a SSL_CERT_FILE-compatible file). */
  caPath: string;
  /**
   * Env additions to merge into the agent's runtime config. Includes
   * HTTPS_PROXY / HTTP_PROXY (so HTTP clients route through the broker)
   * + every CA-trust env var the major language runtimes honor.
   */
  env: Record<string, string>;
}

/** Default hosts / suffixes the agent should bypass the proxy for. */
const DEFAULT_NO_PROXY = [
  "127.0.0.1",
  "localhost",
  // Paperclip control-plane callbacks the agent makes to its own
  // host — these should not pass through the broker. Operators that
  // deploy the broker in standalone mode can extend this list via
  // PAPERCLIP_BROKER_NO_PROXY_EXTRA.
].join(",");

export function materializeBrokerSessionForRuntime(
  session: BrokerRuntimeEnvInput,
): BrokerRuntimeEnv {
  // Per-session tmpdir so concurrent runs don't clash.
  const dir = mkdtempSync(join(tmpdir(), "paperclip-broker-"));
  const caPath = join(dir, "credential-broker-ca.pem");
  writeFileSync(caPath, session.caCertPem, { mode: 0o400 });

  const noProxy = process.env.PAPERCLIP_BROKER_NO_PROXY_EXTRA
    ? `${DEFAULT_NO_PROXY},${process.env.PAPERCLIP_BROKER_NO_PROXY_EXTRA}`
    : DEFAULT_NO_PROXY;

  return {
    caPath,
    env: {
      HTTPS_PROXY: session.proxyUrl,
      HTTP_PROXY: session.proxyUrl,
      // Some HTTP clients honor lowercase variants only.
      https_proxy: session.proxyUrl,
      http_proxy: session.proxyUrl,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      // CA-trust env: the union supported across the language runtimes
      // we care about. Same set Infisical Agent Vault documents.
      SSL_CERT_FILE: caPath,
      NODE_EXTRA_CA_CERTS: caPath,
      REQUESTS_CA_BUNDLE: caPath,
      CURL_CA_BUNDLE: caPath,
      GIT_SSL_CAINFO: caPath,
      DENO_CERT: caPath,
    },
  };
}
