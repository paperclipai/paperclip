export interface BuildManifest {
  sha: string;
  deployedAt: string;
}

export type FetchFn = typeof fetch;

/**
 * Fetches a target product's `/__build.json` endpoint. Each verified product is expected to
 * expose this at build time so the verification worker can confirm it's running against the
 * deploy it was asked to verify.
 */
export async function fetchBuildManifest(baseUrl: string, fetchImpl: FetchFn = fetch): Promise<BuildManifest> {
  const url = `${baseUrl.replace(/\/$/, "")}/__build.json`;
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`build manifest fetch failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as unknown;
  if (
    !data ||
    typeof data !== "object" ||
    typeof (data as { sha?: unknown }).sha !== "string" ||
    typeof (data as { deployedAt?: unknown }).deployedAt !== "string"
  ) {
    throw new Error("build manifest missing required fields (sha, deployedAt)");
  }
  return { sha: (data as BuildManifest).sha, deployedAt: (data as BuildManifest).deployedAt };
}

export interface WaitForShaInput {
  baseUrl: string;
  expectedSha: string;
  maxAttempts?: number;
  delayMs?: number;
  fetchImpl?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitForShaResult {
  matched: boolean;
  deployedSha: string;
}

/**
 * Confirms the deployed SHA at the target matches the expected SHA, polling up to `maxAttempts`
 * with `delayMs` between attempts. Used by the URL runner before executing a spec, so specs never
 * run against stale code.
 */
export async function waitForSha(input: WaitForShaInput): Promise<WaitForShaResult> {
  const {
    baseUrl,
    expectedSha,
    maxAttempts = 1,
    delayMs = 0,
    fetchImpl = fetch,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = input;
  let lastSha = "";
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    const manifest = await fetchBuildManifest(baseUrl, fetchImpl);
    lastSha = manifest.sha;
    if (manifest.sha === expectedSha) return { matched: true, deployedSha: manifest.sha };
  }
  return { matched: false, deployedSha: lastSha };
}
