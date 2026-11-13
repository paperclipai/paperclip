#!/usr/bin/env node
// Opt-in transport diagnostic, NOT a signed Slack event or an agent smoke test.
import { Resolver } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export const TIMEOUT_MS = 8_000;
export const INERT_BODY = "{}";
// A real v0 signature has 64 hexadecimal hash characters. This cannot match it.
export const INVALID_SIGNATURE = "v0=ingress-canary-invalid";
const USAGE = `Usage: node scripts/smoke/chat-webhook-ingress.mjs --url HTTPS_SLACK_WEBHOOK
  [--compare-url HTTP_LOOPBACK_SAME_PATH] [--relay-ip PUBLIC_IP]

No arguments or --help sends nothing. The public URL must use a DNS hostname
and /api/chat-webhooks/<public-id>/slack; no credentials, query or fragment.
The optional comparator must use literal 127.0.0.1 or [::1] with the same path.
The relay override pins one public IP while retaining the public hostname/SNI.
Without an override, DNS answers must all be public. HTTP requests are not retried.
One inert, invalid-signature POST per target; 8 seconds maximum per target.
No redirects, response bodies, cookies, credentials or environment proxy use.
Clear NODE_DEBUG/NODE_DEBUG_NATIVE and TLS tracing before network diagnostics.
Only 401 is an expected rejection; other statuses are unexpected (exit 1).
A 401 is compatible with reaching the signature verifier, not proof of signed
event admission or chat quality. Correlate with local verifier logs if needed.
Timings are cumulative milliseconds from each target's start; null means unseen.
Output excludes URLs, public IDs, addresses, headers and raw error messages.
`;

class ConfigurationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const privateV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
])
  privateV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const specialV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
])
  specialV6.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(value) {
  if (typeof value !== "string" || /[%\s]/u.test(value)) return false;
  const family = isIP(value);
  if (family === 4) return !privateV4.check(value, "ipv4");
  return (
    family === 6 &&
    globalV6.check(value, "ipv6") &&
    !specialV6.check(value, "ipv6")
  );
}

function parseUrl(raw, comparison = false) {
  // Reject parser normalization, encoded path/header tricks and even empty ?/#.
  if (
    typeof raw !== "string" ||
    /[\s\u0000-\u001f\u007f-\u009f%\\@?#]/u.test(raw)
  ) {
    throw new ConfigurationError("invalid_url");
  }
  const match = /^(https?):\/\/([^/]+)(\/.*)$/u.exec(raw);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError("invalid_url");
  }
  if (
    !match ||
    match[3] !== url.pathname ||
    url.port === "0" ||
    !/^\/api\/chat-webhooks\/[A-Za-z0-9_-]{16,128}\/slack$/u.test(url.pathname)
  ) {
    throw new ConfigurationError("invalid_webhook_path");
  }
  if (comparison) {
    // Exact literals only: no host-file, DNS, alternate integer IPv4 or rebinding.
    if (!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?\//u.test(raw)) {
      throw new ConfigurationError("comparison_must_be_loopback_http");
    }
  } else {
    if (
      url.protocol !== "https:" ||
      isIP(url.hostname) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
        url.hostname,
      ) ||
      /\.(?:localhost|local|internal|invalid|test)$/u.test(url.hostname)
    ) {
      throw new ConfigurationError("public_url_must_be_https_hostname");
    }
  }
  return url;
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== "string")) {
    throw new ConfigurationError("invalid_arguments");
  }
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--help"))
    return { help: true };
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (
      !["--url", "--compare-url", "--relay-ip"].includes(key) ||
      values.has(key) ||
      !argv[index + 1] ||
      argv[index + 1].startsWith("--")
    ) {
      throw new ConfigurationError("invalid_arguments");
    }
    values.set(key, argv[index + 1]);
  }
  if (!values.has("--url"))
    throw new ConfigurationError("explicit_public_url_required");
  const publicUrl = parseUrl(values.get("--url"));
  const relayIp = values.get("--relay-ip") ?? null;
  if (relayIp !== null && !isPublicAddress(relayIp))
    throw new ConfigurationError("unsafe_relay_ip");
  const targets = [
    { label: "public", url: publicUrl, relayIp, host: publicUrl.host },
  ];
  if (values.has("--compare-url")) {
    const url = parseUrl(values.get("--compare-url"), true);
    if (url.pathname !== publicUrl.pathname)
      throw new ConfigurationError("comparison_path_mismatch");
    targets.push({
      label: "comparison",
      url,
      relayIp: null,
      host: publicUrl.host,
    });
  }
  return { help: false, targets };
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ENODATA",
  "EAI_AGAIN",
  "ESERVFAIL",
  "ECANCELLED",
  "EPIPE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "HPE_HEADER_OVERFLOW",
  "HPE_INVALID_HEADER_TOKEN",
]);
function safeNetworkCode(error) {
  return NETWORK_CODES.has(error?.code) ? error.code : "NETWORK_ERROR";
}

// Injectable I/O is for local fixture tests only; the CLI always uses these native
// implementations. There is no CLI switch for TLS bypass or a private relay.
export async function probeTarget(
  target,
  {
    createResolver = () => new Resolver({ timeout: TIMEOUT_MS, tries: 1 }),
    request = target.label === "public" ? https.request : http.request,
    timeoutMs = TIMEOUT_MS,
  } = {},
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TIMEOUT_MS) {
    throw new ConfigurationError("invalid_timeout");
  }
  const start = performance.now();
  const result = {
    target: target.label,
    startedAt: new Date().toISOString(),
    outcome: null,
    status: null,
    errorCode: null,
    timingsMs: { dns: null, connect: null, tls: null, ttfb: null, total: null },
  };
  const elapsed = () => Math.round((performance.now() - start) * 1_000) / 1_000;
  let resolver;
  let agent;
  let req;
  let response;
  let done = false;
  return new Promise((resolve) => {
    function finish(outcome, code = null) {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolver?.cancel();
      response?.destroy(); // Never consume, retain or display response content.
      req?.destroy();
      agent?.destroy();
      result.outcome = outcome;
      result.errorCode = code;
      result.timingsMs.total = elapsed();
      resolve(result);
    }
    // Covers DNS as well as TCP/TLS/header wait; destroy cancels actual I/O.
    const deadline = setTimeout(
      () => finish("timeout", "DEADLINE_EXCEEDED"),
      timeoutMs,
    );
    async function send() {
      let address = target.relayIp;
      if (target.label === "public" && !address) {
        resolver = createResolver();
        const answers = await Promise.allSettled([
          resolver.resolve4(target.url.hostname),
          resolver.resolve6(target.url.hostname),
        ]);
        if (done) return;
        result.timingsMs.dns = elapsed();
        const addresses = answers.flatMap((answer) =>
          answer.status === "fulfilled" ? answer.value : [],
        );
        if (addresses.length === 0) {
          finish(
            "network_error",
            safeNetworkCode(
              answers.find((answer) => answer.status === "rejected")?.reason,
            ),
          );
          return;
        }
        if (!addresses.every(isPublicAddress)) {
          finish("unsafe_resolution", "NON_PUBLIC_DNS_ANSWER");
          return;
        }
        address = addresses[0]; // One pinned address, no fallback/retry.
      }
      if (done) return;
      if (target.label === "comparison")
        address = target.url.hostname.replace(/^\[|\]$/gu, "");
      // A fresh explicit agent ignores global/env proxy agents and session caches.
      const Agent = target.label === "public" ? https.Agent : http.Agent;
      agent = new Agent({
        keepAlive: false,
        maxSockets: 1,
        proxyEnv: {},
        maxCachedSessions: 0,
      });
      function onResponse(res) {
        response = res;
        res.on("error", () => {}); // Raw response errors may contain private data.
        if (done) {
          res.destroy();
          return;
        }
        result.status = res.statusCode ?? null;
        result.timingsMs.ttfb = elapsed();
        finish(
          result.status === 401 ? "expected_rejection" : "unexpected_status",
        );
      }
      req = request(
        {
          protocol: target.url.protocol,
          hostname: target.url.hostname.replace(/^\[|\]$/gu, ""),
          port: target.url.port || (target.label === "public" ? 443 : 80),
          path: target.url.pathname,
          method: "POST",
          agent,
          servername:
            target.label === "public" ? target.url.hostname : undefined,
          rejectUnauthorized: true,
          autoSelectFamily: false,
          family: isIP(address),
          lookup: (_hostname, options, callback) => {
            const selected = { address, family: isIP(address) };
            callback(
              null,
              options?.all ? [selected] : address,
              selected.family,
            );
          },
          maxHeaderSize: 16_384,
          headers: {
            Host: target.host,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(INERT_BODY),
            "X-Slack-Request-Timestamp": String(Math.floor(Date.now() / 1_000)),
            "X-Slack-Signature": INVALID_SIGNATURE,
            Connection: "close",
          },
        },
        onResponse,
      );
      req.once("upgrade", (res, socket) => {
        socket.destroy(); // A 101 is unexpected too; never enter another protocol.
        onResponse(res);
      });
      req.on("socket", (socket) => {
        socket.once("connect", () => {
          if (!done) result.timingsMs.connect = elapsed();
        });
        socket.once("secureConnect", () => {
          if (!done) result.timingsMs.tls = elapsed();
        });
      });
      req.on("error", (error) =>
        finish("network_error", safeNetworkCode(error)),
      );
      req.end(INERT_BODY);
    }
    void send().catch((error) =>
      finish("network_error", safeNetworkCode(error)),
    );
  });
}

export async function main(
  argv,
  { write = (line) => process.stdout.write(line), probe = probeTarget } = {},
) {
  let config;
  try {
    config = parseArgs(argv);
  } catch (error) {
    write(
      `${JSON.stringify({ outcome: "invalid_configuration", errorCode: error instanceof ConfigurationError ? error.code : "INVALID_CONFIGURATION" })}\n`,
    );
    return 2;
  }
  if (config.help) {
    write(USAGE);
    return 0;
  }
  // Core's debug logging bypasses our redaction and can include request options.
  // Refuse networking rather than trying to intercept global stdout/stderr.
  if (
    process.env.NODE_DEBUG?.trim() ||
    process.env.NODE_DEBUG_NATIVE?.trim() ||
    process.execArgv.some((arg) => /^--trace[-_]tls(?:=|$)/u.test(arg)) ||
    /(?:^|[\s"'])--trace[-_]tls(?:[=\s"']|$)/u.test(
      process.env.NODE_OPTIONS ?? "",
    )
  ) {
    write(
      `${JSON.stringify({ outcome: "invalid_configuration", errorCode: "UNSAFE_DEBUG_ENVIRONMENT" })}\n`,
    );
    return 2;
  }
  let exitCode = 0;
  for (const target of config.targets) {
    try {
      const result = await probe(target);
      write(`${JSON.stringify(result)}\n`);
      if (result.outcome !== "expected_rejection") exitCode = 1;
    } catch {
      // Never surface subprocess/network messages, stacks, paths or caller input.
      write(
        `${JSON.stringify({ target: target.label, outcome: "diagnostic_error", errorCode: "DIAGNOSTIC_ERROR" })}\n`,
      );
      exitCode = 1;
    }
  }
  return exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
