#!/usr/bin/env node
import { parseAcpxCandidateStartupAdmission, type AcpxCandidateStartupAdmission } from "../drivers/acpx/candidate-admission.js";
import { probeKimiMetadata } from "../drivers/acpx/kimi-metadata-probe.js";
import { KIMI_NODE_VERSION } from "../drivers/acpx/kimi-closure-pins.js";

async function main() {
  const model = process.env.PAPERCLIP_KIMI_PROBE_MODEL ?? "", apiKey = process.env.KIMI_API_KEY ?? "";
  const encodedAdmission = process.env.PAPERCLIP_ACPX_CANDIDATE_ADMISSION;
  const bindings = { PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT: process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT,
    PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST: process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST };
  for (const name of Object.keys(process.env)) delete process.env[name];
  for (const [name, value] of Object.entries(bindings)) if (value !== undefined) process.env[name] = value;
  let candidateAdmission: AcpxCandidateStartupAdmission | undefined;
  if (encodedAdmission !== undefined) {
    if (Buffer.byteLength(encodedAdmission) > 4096) throw new Error("Invalid metadata admission");
    candidateAdmission = parseAcpxCandidateStartupAdmission(JSON.parse(encodedAdmission), { agent: "kimi", model });
  }
  const result = process.versions.node !== KIMI_NODE_VERSION
    ? { schema: "paperclip.kimi.metadata.v1", status: "failed", code: "KIMI_INSTALLATION_INVALID",
        message: "Kimi metadata verification requires the pinned Node runtime.", promptSent: false }
    : await probeKimiMetadata(model, apiKey, candidateAdmission);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "verified") process.exitCode = 1;
}

void main().catch(() => {
  process.stdout.write(`${JSON.stringify({ schema: "paperclip.kimi.metadata.v1", status: "failed", code: "KIMI_REQUEST_FAILED",
    message: "Kimi Code metadata verification failed.", promptSent: false })}\n`);
  process.exitCode = 1;
});
