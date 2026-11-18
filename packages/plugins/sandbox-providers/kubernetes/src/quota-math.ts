/**
 * Quota arithmetic for the per-company ResourceQuota.
 *
 * Every sandbox pod defaults to requests 250m CPU / 512Mi and limits 2 CPU /
 * 4Gi (see sandbox-cr-builder.ts). ResourceQuota counts the limits, so a quota
 * that caps `pods` at 20 but limits.cpu at 20 only ever admits 10 pods. The
 * default quota is therefore derived from the pod cap and the per-pod defaults:
 * every pod the cap allows also fits the CPU and memory caps.
 */

export const POD_DEFAULT_REQUESTS = { cpu: "250m", memory: "512Mi" } as const;
export const POD_DEFAULT_LIMITS = { cpu: "2", memory: "4Gi" } as const;

const MEMORY_UNITS: Record<string, number> = {
  "": 1,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
};

/** CPU quantity to millicores (`2` -> 2000, `250m` -> 250, `1.5` -> 1500). NaN when unparseable. */
export function parseCpuMilli(value: string | undefined): number {
  if (typeof value !== "string") return NaN;
  const match = /^(\d+(?:\.\d+)?)(m?)$/.exec(value.trim());
  if (!match) return NaN;
  const n = Number(match[1]);
  return match[2] === "m" ? n : Math.round(n * 1000);
}

/** Memory quantity to bytes (`4Gi`, `512Mi`, `1G`, `1024`). NaN when unparseable. */
export function parseMemoryBytes(value: string | undefined): number {
  if (typeof value !== "string") return NaN;
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|k|K|M|G|T|P|E)?$/.exec(value.trim());
  if (!match) return NaN;
  return Math.round(Number(match[1]) * MEMORY_UNITS[match[2] ?? ""]!);
}

function formatCpuMilli(milli: number): string {
  return milli % 1000 === 0 ? String(milli / 1000) : `${milli}m`;
}

function formatMiB(mib: number): string {
  return mib % 1024 === 0 ? `${mib / 1024}Gi` : `${mib}Mi`;
}

export interface QuotaValues {
  pods: string;
  requestsCpu: string;
  requestsMemory: string;
  limitsCpu: string;
  limitsMemory: string;
}

/** Default quota for a pod cap: room for that many default-sized pods on every dimension. */
export function defaultQuotaForPods(pods: number): QuotaValues {
  return {
    pods: String(pods),
    requestsCpu: formatCpuMilli(250 * pods),
    requestsMemory: formatMiB(512 * pods),
    limitsCpu: formatCpuMilli(2000 * pods),
    limitsMemory: formatMiB(4096 * pods),
  };
}

export interface PodQuotaNeed {
  requestsCpuMilli: number;
  requestsMemoryBytes: number;
  limitsCpuMilli: number;
  limitsMemoryBytes: number;
}

/**
 * What one new sandbox pod adds to the namespace's quota usage. Mirrors the pod
 * builder: `defaultResources.requests` / `.limits` replace the defaults as a
 * whole object; a missing cpu or memory inside them is not counted.
 */
export function podQuotaNeed(defaultResources?: {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
}): PodQuotaNeed {
  const requests = defaultResources?.requests ?? POD_DEFAULT_REQUESTS;
  const limits = defaultResources?.limits ?? POD_DEFAULT_LIMITS;
  const num = (v: number) => (Number.isFinite(v) ? v : 0);
  return {
    requestsCpuMilli: num(parseCpuMilli(requests.cpu)),
    requestsMemoryBytes: num(parseMemoryBytes(requests.memory)),
    limitsCpuMilli: num(parseCpuMilli(limits.cpu)),
    limitsMemoryBytes: num(parseMemoryBytes(limits.memory)),
  };
}
