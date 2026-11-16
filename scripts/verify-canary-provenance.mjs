#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export const RELEASE_WORKFLOW = Object.freeze({
  repository: "https://github.com/paperclipai/paperclip",
  path: ".github/workflows/release.yml",
  ref: "refs/heads/master",
});

const CANARY_VERSION = /^\d+\.\d+\.\d+-canary\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;

function slsaStatements(attestations) {
  return (attestations?.attestations ?? [])
    .filter((entry) => typeof entry?.predicateType === "string" && entry.predicateType.startsWith("https://slsa.dev/provenance/"))
    .map((entry) => {
      try {
        return JSON.parse(Buffer.from(entry.bundle?.dsseEnvelope?.payload ?? "", "base64").toString("utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function packageProvenance(attestations, { packageName, version, sourceSha }) {
  const subject = `pkg:npm/${packageName.replace(/^@/, "%40")}@${version}`;
  const statements = slsaStatements(attestations);
  if (statements.length === 0) return "none";
  const matches = statements.some((statement) => {
    const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
    const commit = statement.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit;
    return statement.subject?.some((entry) => entry?.name === subject)
      && workflow.repository === RELEASE_WORKFLOW.repository
      && workflow.path === RELEASE_WORKFLOW.path
      && workflow.ref === RELEASE_WORKFLOW.ref
      && commit === sourceSha;
  });
  return matches ? "match" : "mismatch";
}

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);

async function fetchAttestations(url, { fetcher, attempts, sleep }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
      if (response.status === 404) return null;
      if (response.ok) return await response.json();
      if (!TRANSIENT.has(response.status)) throw Object.assign(new Error(`HTTP ${response.status}`), { permanent: true });
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (error.permanent) throw error;
      lastError = error;
    }
    if (attempt < attempts) await sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
  }
  throw lastError;
}

export async function verifyCanaryProvenance({ packages, version, sourceSha, fetcher = fetch, attempts = 5,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!CANARY_VERSION.test(version ?? "")) throw new Error(`not a canary version: ${version}`);
  if (!SHA.test(sourceSha ?? "")) throw new Error(`not a full commit SHA: ${sourceSha}`);
  if (!packages?.length) throw new Error("at least one package is required");
  const problems = [];
  const withoutProvenance = [];
  let matched = 0;
  for (const packageName of packages) {
    const url = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(packageName).replace(/^%40/, "@")}@${version}`;
    let attestations;
    try {
      attestations = await fetchAttestations(url, { fetcher, attempts, sleep });
    } catch (error) {
      problems.push(`${packageName}@${version}: attestations unavailable (${error.message})`);
      continue;
    }
    const result = attestations ? packageProvenance(attestations, { packageName, version, sourceSha }) : "none";
    if (result === "match") matched += 1;
    else if (result === "none") withoutProvenance.push(packageName);
    else problems.push(`${packageName}@${version}: provenance does not name ${RELEASE_WORKFLOW.path} on ${RELEASE_WORKFLOW.ref} at ${sourceSha}`);
  }
  return { problems, matched, withoutProvenance };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, sourceSha, ...packages] = process.argv.slice(2);
  try {
    const { problems, matched, withoutProvenance } = await verifyCanaryProvenance({ packages, version, sourceSha });
    if (problems.length) {
      for (const problem of problems) console.error(problem);
      process.exitCode = 1;
    } else {
      console.log(`Provenance for ${matched} of ${packages.length} packages names ${RELEASE_WORKFLOW.path} at ${sourceSha}.`);
      if (withoutProvenance.length) console.log(`Published without provenance (npm transparency-log retry): ${withoutProvenance.join(", ")}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
