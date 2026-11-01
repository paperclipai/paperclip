import { randomUUID } from "node:crypto";
import { runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { kimiMetadataProbeDigest, kimiMetadataProbeNodeDigest, probeKimiMetadata, validateKimiMetadata } from "../vendor/paperclip-runner/live/index.js";
import { unprocessable } from "../errors.js";
import { createSshCommandManagedRuntimeRunner, runSshCommand } from "@paperclipai/adapter-utils/ssh";
import { QUALIFIED_ACPX_PROFILES } from "../vendor/paperclip-runner/index.js";
import { resolveKimiCandidateAdmission } from "./native-runtime/acpx-qualification.js";

const REQUEST_FAILED = () => unprocessable("Kimi Code metadata verification failed.", { code: "KIMI_REQUEST_FAILED" });
const INSTALLATION_INVALID = () => unprocessable("Install the current verified Kimi Code runtime in this execution environment.", { code: "KIMI_INSTALLATION_INVALID" });

const SSH_INPUT_PROBE = 'try { const input = JSON.parse(require("node:fs").readFileSync(0, "utf8")); if (typeof input.apiKey !== "string" || typeof input.model !== "string") process.exit(1); process.env.KIMI_API_KEY = input.apiKey; process.env.PAPERCLIP_KIMI_PROBE_MODEL = input.model; if (input.candidateAdmission !== undefined) process.env.PAPERCLIP_ACPX_CANDIDATE_ADMISSION = JSON.stringify(input.candidateAdmission); require(process.argv[1]); } catch { process.exit(1); }';

export async function probeKimiExecutionTarget(apiKey: string, target: AdapterExecutionTarget | null | undefined, model: string, context: { companyId?: string } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\0\r\n]/.test(apiKey) || Buffer.byteLength(apiKey) > 16 * 1024) {
    throw unprocessable("Bind a valid company secret to KIMI_API_KEY.", { code: "KIMI_AUTH_REQUIRED" });
  }
  if (typeof model !== "string" || !model.trim() || model.includes("\0") || Buffer.byteLength(model) > 512 || Buffer.from(model).toString("utf8") !== model) {
    throw unprocessable("Select the exact Kimi Code model.", { code: "KIMI_MODEL_UNAVAILABLE" });
  }
  let candidateAdmission: Parameters<typeof probeKimiMetadata>[2];
  if (QUALIFIED_ACPX_PROFILES.kimi.qualificationStatus === "pending") {
    try {
      const admission = resolveKimiCandidateAdmission({ companyId: context.companyId, model,
        target: target?.kind === "remote" ? { platform: "linux", architecture: "x64" } : { platform: process.platform, architecture: process.arch } });
      if (!admission) throw new Error("Missing candidate admission");
      const probeId = `kimi-metadata-${randomUUID()}`;
      candidateAdmission = { ...admission, runId: probeId, normalizedSessionId: `metadata-${randomUUID()}` };
    } catch {
      throw unprocessable("Kimi Code qualification requires current trusted operator admission for this company and execution target.", { code: "KIMI_QUALIFICATION_REQUIRED" });
    }
  }
  if (!target || target.kind === "local") {
    const result = validateKimiMetadata(await probeKimiMetadata(model, apiKey, candidateAdmission), model);
    if (result.status !== "verified") throw unprocessable(result.message, { code: result.code });
    return result;
  }
  if (target.transport === "sandbox" && target.runnerTask) {
    throw unprocessable("Kimi Code metadata verification is unavailable in this hosting environment.", { code: "KIMI_INSTALLATION_INVALID" });
  }
  let locations = ["/opt/paperclip-runner/provider-pack", '"$HOME/.local/share/paperclip-runner/provider-pack"'];
  const selectedPackRoot = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH?.trim();
  if (selectedPackRoot) {
    try {
      // Test uses the same complete-pack installer as native execution. It
      // needs no native run/session or DB context and opens no model session.
      const { prepareRemoteProviderPackOnTarget, resolveRemoteProviderPackSource } = await import("./native-runtime/native-session-executor.js");
      const selected = resolveRemoteProviderPackSource(selectedPackRoot);
      if (selected.manifest.payload.target.platform !== "linux" || selected.manifest.payload.target.architecture !== "x64") throw INSTALLATION_INVALID();
      const runner = target.transport === "ssh" ? createSshCommandManagedRuntimeRunner({ spec: target.spec, defaultCwd: target.remoteCwd }) : target.runner;
      if (!runner) throw INSTALLATION_INVALID();
      const prepared = await prepareRemoteProviderPackOnTarget({ target, runner,
        configuredProviderPackRoot: selected.configuredRoot, manifest: selected.manifest });
      locations = [`'${prepared.root.replaceAll("'", "'\\''")}'`];
    } catch { throw INSTALLATION_INVALID(); }
  }
  // Preparation retains the normal installer's bounded stages. The existing
  // metadata/HTTP budget begins only after that preparation has completed.
  const deadlineAt = Date.now() + 35_000;
  let digest: string;
  try { digest = await kimiMetadataProbeDigest(); }
  catch { throw INSTALLATION_INVALID(); }
  const nodeDigest = kimiMetadataProbeNodeDigest();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) || !/^sha256:[a-f0-9]{64}$/.test(nodeDigest)) throw INSTALLATION_INVALID();
  for (const location of locations) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 3_000) throw REQUEST_FAILED();
    const command = [
      `pack=${location}`,
      'entry="$pack/dist/cli/kimi-metadata-probe.cjs"; node="$pack/provider-assets/kimi/linux-x64/runtime/node/bin/node"',
      '[ -f "$pack/provider-pack.json" ] && [ -f "$entry" ] && [ ! -L "$entry" ] && [ -x "$node" ] && [ ! -L "$node" ] || exit 127',
      'unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_USE_ENV_PROXY NODE_TLS_REJECT_UNAUTHORIZED OPENSSL_CONF SSL_CERT_FILE SSL_CERT_DIR HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT GLIBC_TUNABLES DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH',
      'PATH=/usr/bin:/bin; export PATH',
      'actual=$(/usr/bin/env -i /usr/bin/sha256sum "$entry" 2>/dev/null) || exit 126',
      `actual=\${actual%% *}; [ "$actual" = "${digest.slice(7)}" ] || exit 126`,
      'actual=$(/usr/bin/env -i /usr/bin/sha256sum "$node" 2>/dev/null) || exit 126',
      `actual=\${actual%% *}; [ "$actual" = "${nodeDigest.slice(7)}" ] || exit 126`,
      target.transport === "ssh"
        ? `exec /usr/bin/env -i PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT="$pack" PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST="$pack/package.json" "$node" -e '${SSH_INPUT_PROBE}' "$entry"`
        : ['exec /usr/bin/env -i KIMI_API_KEY="$KIMI_API_KEY" PAPERCLIP_KIMI_PROBE_MODEL="$PAPERCLIP_KIMI_PROBE_MODEL"',
          ...(candidateAdmission ? ['PAPERCLIP_ACPX_CANDIDATE_ADMISSION="$PAPERCLIP_ACPX_CANDIDATE_ADMISSION"'] : []),
          'PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT="$pack" PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST="$pack/package.json" "$node" "$entry"'].join(" "),
    ].join("; ");
    let response: Pick<Awaited<ReturnType<typeof runAdapterExecutionTargetShellCommand>>, "stdout" | "exitCode" | "signal" | "timedOut">;
    try {
      if (target.transport === "ssh") {
        try {
          const result = await runSshCommand(target.spec, command, {
            stdin: JSON.stringify({ apiKey, model, ...(candidateAdmission ? { candidateAdmission } : {}) }), timeoutMs: Math.max(1, Math.floor((remainingMs - 3_000) / 1000)) * 1000,
          });
          response = { stdout: result.stdout, exitCode: 0, signal: null, timedOut: false };
        } catch (error) {
          const failure = error as { code?: unknown; stdout?: unknown; signal?: string | null };
          if (typeof failure.code !== "number") throw error;
          response = { stdout: typeof failure.stdout === "string" ? failure.stdout : "", exitCode: failure.code,
            signal: failure.signal ?? null, timedOut: false };
        }
      } else {
        response = await runAdapterExecutionTargetShellCommand(`kimi-metadata-${randomUUID()}`, target, command, {
          cwd: target.remoteCwd, env: { KIMI_API_KEY: apiKey, PAPERCLIP_KIMI_PROBE_MODEL: model,
            ...(candidateAdmission ? { PAPERCLIP_ACPX_CANDIDATE_ADMISSION: JSON.stringify(candidateAdmission) } : {}) },
          timeoutSec: Math.max(1, Math.floor((remainingMs - 3_000) / 1000)), graceSec: 3,
        });
      }
    } catch { throw REQUEST_FAILED(); }
    if (Date.now() > deadlineAt || response.timedOut || response.signal || Buffer.byteLength(response.stdout) > 64 * 1024) throw REQUEST_FAILED();
    if ([126, 127].includes(response.exitCode ?? -1)) continue;
    let payload: unknown;
    try { payload = JSON.parse(response.stdout.trim()); } catch { throw REQUEST_FAILED(); }
    const result = validateKimiMetadata(payload, model);
    if (result.status !== "verified") {
      if (result.code === "KIMI_INSTALLATION_INVALID") continue;
      throw unprocessable(result.message, { code: result.code });
    }
    if (response.exitCode !== 0) throw REQUEST_FAILED();
    if (result.target !== "linux-x64") throw INSTALLATION_INVALID();
    return result;
  }
  throw INSTALLATION_INVALID();
}
