#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const DEFAULT_FILE = "/opt/trafficserver/etc/trafficserver/ssl_multicert.config";
const DEFAULT_GATEWAY_LINE_RE = /\bgateway\b/i;

export function meaningfulLines(contents) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function validateSslMulticert(contents, options = {}) {
  const lines = meaningfulLines(contents);
  const expectedLine = options.expectedLine?.trim();
  const gatewayLineRe = options.gatewayLineRe ?? DEFAULT_GATEWAY_LINE_RE;
  const errors = [];

  if (lines.length !== 1) {
    errors.push(`expected exactly one non-comment line, found ${lines.length}`);
  }

  if (expectedLine) {
    if (lines[0] !== expectedLine) {
      errors.push("single line does not match RELAY_SSL_MULTICERT_EXPECTED_LINE");
    }
  } else if (lines[0]) {
    if (!gatewayLineRe.test(lines[0])) {
      errors.push("single line does not look like the gateway certificate line");
    }
    if (!/\bssl_cert_name\b/.test(lines[0]) || !/\bssl_key_name\b/.test(lines[0])) {
      errors.push("single line must declare ssl_cert_name and ssl_key_name");
    }
  }

  return { ok: errors.length === 0, lines, errors };
}

function parseArgs(argv) {
  const args = {
    namespaces: (process.env.RELAY_SSL_MULTICERT_NAMESPACES ?? "staging-traffic-control,production-traffic-control")
      .split(",")
      .map((namespace) => namespace.trim())
      .filter(Boolean),
    selector: process.env.RELAY_SSL_MULTICERT_SELECTOR ?? "app=relay-ats",
    container: process.env.RELAY_SSL_MULTICERT_CONTAINER ?? "",
    file: process.env.RELAY_SSL_MULTICERT_FILE ?? DEFAULT_FILE,
    expectedLine: process.env.RELAY_SSL_MULTICERT_EXPECTED_LINE ?? "",
    kubectl: process.env.KUBECTL ?? "kubectl",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--namespace" && next) {
      args.namespaces = [next];
      i += 1;
    } else if (arg === "--namespaces" && next) {
      args.namespaces = next.split(",").map((namespace) => namespace.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--selector" && next) {
      args.selector = next;
      i += 1;
    } else if (arg === "--container" && next) {
      args.container = next;
      i += 1;
    } else if (arg === "--file" && next) {
      args.file = next;
      i += 1;
    } else if (arg === "--expected-line" && next) {
      args.expectedLine = next;
      i += 1;
    } else if (arg === "--kubectl" && next) {
      args.kubectl = next;
      i += 1;
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }

  if (args.namespaces.length === 0) throw new Error("at least one namespace is required");
  if (!args.selector) throw new Error("--selector is required");
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/check-relay-ssl-multicert.mjs [options]\n\nChecks every selected relay pod's ${DEFAULT_FILE} via kubectl exec.\n\nOptions:\n  --namespaces <csv>     Namespace list (default: RELAY_SSL_MULTICERT_NAMESPACES)\n  --namespace <name>     Single namespace\n  --selector <selector>  Relay pod selector (default: app=relay-ats)\n  --container <name>     Optional container name for kubectl exec\n  --file <path>          File to read inside each pod\n  --expected-line <line> Exact gateway-only line to require\n  --kubectl <path>       kubectl executable path\n`);
}

function kubectl(args, options) {
  return execFileSync(options.kubectl, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function listPods(namespace, options) {
  const output = kubectl(
    ["-n", namespace, "get", "pods", "-l", options.selector, "--field-selector", "status.phase=Running", "-o", "jsonpath={range .items[*]}{.metadata.name}{'\\n'}{end}"],
    options,
  );
  return output.split("\n").map((pod) => pod.trim()).filter(Boolean);
}

function readPodFile(namespace, pod, options) {
  const args = ["-n", namespace, "exec", pod];
  if (options.container) args.push("-c", options.container);
  args.push("--", "cat", options.file);
  return kubectl(args, options);
}

export function run(options) {
  const failures = [];
  const checked = [];

  for (const namespace of options.namespaces) {
    const pods = listPods(namespace, options);
    if (pods.length === 0) {
      failures.push(`${namespace}: no running relay pods matched selector ${options.selector}`);
      continue;
    }

    for (const pod of pods) {
      const contents = readPodFile(namespace, pod, options);
      const result = validateSslMulticert(contents, { expectedLine: options.expectedLine });
      checked.push(`${namespace}/${pod}`);
      if (!result.ok) {
        failures.push(`${namespace}/${pod}: ${result.errors.join("; ")} (lines=${JSON.stringify(result.lines)})`);
      }
    }
  }

  return { ok: failures.length === 0, checked, failures };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = run(options);

  for (const pod of result.checked) console.log(`PASS ${pod}`);
  if (!result.ok) {
    for (const failure of result.failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(`relay ssl_multicert gateway-only guard passed for ${result.checked.length} pod(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
