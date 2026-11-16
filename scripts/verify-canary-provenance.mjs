#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export const RELEASE_WORKFLOW = Object.freeze({
  repository: "https://github.com/paperclipai/paperclip",
  path: ".github/workflows/release.yml",
  ref: "refs/heads/master",
});

const CANARY_VERSION = /^\d+\.\d+\.\d+-canary\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;

export function provenanceProblems(attestations, { packageName, version, sourceSha }) {
  const subject = `pkg:npm/${packageName.replace(/^@/, "%40")}@${version}`;
  const statements = (attestations?.attestations ?? [])
    .filter((entry) => typeof entry?.predicateType === "string" && entry.predicateType.startsWith("https://slsa.dev/provenance/"))
    .map((entry) => {
      try {
        return JSON.parse(Buffer.from(entry.bundle?.dsseEnvelope?.payload ?? "", "base64").toString("utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (statements.length === 0) return [`${packageName}@${version}: no SLSA provenance`];
  const matching = statements.find((statement) => {
    const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
    const commit = statement.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit;
    return statement.subject?.some((entry) => entry?.name === subject)
      && workflow.repository === RELEASE_WORKFLOW.repository
      && workflow.path === RELEASE_WORKFLOW.path
      && workflow.ref === RELEASE_WORKFLOW.ref
      && commit === sourceSha;
  });
  return matching ? [] : [`${packageName}@${version}: provenance does not name ${RELEASE_WORKFLOW.path} on ${RELEASE_WORKFLOW.ref} at ${sourceSha}`];
}

export async function verifyCanaryProvenance({ packages, version, sourceSha, fetcher = fetch }) {
  if (!CANARY_VERSION.test(version ?? "")) throw new Error(`not a canary version: ${version}`);
  if (!SHA.test(sourceSha ?? "")) throw new Error(`not a full commit SHA: ${sourceSha}`);
  if (!packages?.length) throw new Error("at least one package is required");
  const problems = [];
  for (const packageName of packages) {
    const url = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(packageName).replace(/^%40/, "@")}@${version}`;
    const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      problems.push(`${packageName}@${version}: attestations unavailable (HTTP ${response.status})`);
      continue;
    }
    problems.push(...provenanceProblems(await response.json(), { packageName, version, sourceSha }));
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, sourceSha, ...packages] = process.argv.slice(2);
  try {
    const problems = await verifyCanaryProvenance({ packages, version, sourceSha });
    if (problems.length) {
      for (const problem of problems) console.error(problem);
      process.exitCode = 1;
    } else {
      console.log(`Provenance for ${packages.length} packages names ${RELEASE_WORKFLOW.path} at ${sourceSha}.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
