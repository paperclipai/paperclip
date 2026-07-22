export type Coordinates = [number, number];

export interface ProspectDistanceCandidate {
  account_id: string;
  score: number;
}

export interface DrivingMetric {
  distance_km: number;
  duration_minutes: number;
}

export interface OutreachQueueCandidate extends ProspectDistanceCandidate, DrivingMetric {
  name: string;
  email: string;
  website: string;
  canton: string;
  city: string;
  score_reasons: string[];
  outreach_lane: "local" | "exceptional";
  distance_precision?: "street" | "locality";
}

export interface DistanceQueueSelection<T extends ProspectDistanceCandidate> {
  origin: string;
  active_radius_km: number | null;
  local: Array<T & DrivingMetric & { outreach_lane: "local" }>;
  exceptional: Array<T & DrivingMetric & { outreach_lane: "exceptional" }>;
}

const DEFAULT_DISTANCE_BANDS_KM = [35, 70, 120];

export function calculateQueueRefill(input: {
  localTarget: number;
  exceptionalTarget: number;
  occupiedLocal: number;
  occupiedExceptional: number;
}): {
  local: number;
  exceptional: number;
  total: number;
} {
  const local = Math.max(0, input.localTarget - input.occupiedLocal);
  const exceptional = Math.max(0, input.exceptionalTarget - input.occupiedExceptional);
  return { local, exceptional, total: local + exceptional };
}

export function buildOutreachTaskPairBrief(candidate: OutreachQueueCandidate, input: {
  origin: string;
  activeRadiusKm: number | null;
}): {
  researchTitle: string;
  researchDescription: string;
  draftTitle: string;
  draftDescription: string;
} {
  const facts = [
    `Account ID: ${candidate.account_id}`,
    `Verified CRM email: ${candidate.email}`,
    `Website: ${candidate.website || "not recorded"}`,
    `CRM location: ${candidate.city}, ${candidate.canton}`,
    `CRM score: ${candidate.score}`,
    `Score evidence: ${candidate.score_reasons.join("; ")}`,
    `Origin: ${input.origin}`,
    `OSRM driving distance: ${candidate.distance_km} km`,
    `OSRM driving time: ${candidate.duration_minutes} minutes`,
    `Distance precision: ${candidate.distance_precision || "unknown"}`,
    `Active local radius: ${input.activeRadiusKm ?? "all qualified"} km`,
    `Outreach lane: ${candidate.outreach_lane}`,
  ].join("\n");
  return {
    researchTitle: `Research outreach account: ${candidate.name}`,
    researchDescription: `${facts}\n\nCompile a sourced venue dossier for the canonical blocked REV-06 task. Never send mail.`,
    draftTitle: `Draft outreach: ${candidate.name}`,
    draftDescription:
      `[OUTREACH_LANE:${candidate.outreach_lane}]\n${facts}\n\n`
      + "Wait for the blocking REV-04 research dossier. Then produce one bespoke first-contact draft, "
      + "run review_draft with this account id and recipient, and create exactly one editable approval. "
      + "Do not send.",
  };
}

export function selectDistanceQueue<T extends ProspectDistanceCandidate>(
  candidates: T[],
  metrics: ReadonlyMap<string, DrivingMetric>,
  options: {
    origin: string;
    localSlots?: number;
    exceptionalSlots?: number;
    distanceBandsKm?: number[];
    minimumScore?: number;
  },
): DistanceQueueSelection<T> {
  const localSlots = Math.max(0, Math.trunc(options.localSlots ?? 10));
  const exceptionalSlots = Math.max(0, Math.trunc(options.exceptionalSlots ?? 2));
  const bands = (options.distanceBandsKm ?? DEFAULT_DISTANCE_BANDS_KM)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const minimumScore = Number.isFinite(options.minimumScore)
    ? Number(options.minimumScore)
    : 60;
  const reachable = candidates
    .filter((candidate) => candidate.score >= minimumScore)
    .map((candidate) => {
      const metric = metrics.get(candidate.account_id);
      return metric ? { ...candidate, ...metric } : null;
    })
    .filter((candidate): candidate is T & DrivingMetric => candidate !== null);

  let activeRadius: number | null = null;
  for (const radius of bands) {
    if (reachable.filter((candidate) => candidate.distance_km <= radius).length >= localSlots) {
      activeRadius = radius;
      break;
    }
  }

  const localPool = activeRadius === null
    ? reachable
    : reachable.filter((candidate) => candidate.distance_km <= activeRadius);
  const local = localPool
    .sort(
      (a, b) =>
        b.score - a.score
        || a.distance_km - b.distance_km
        || a.account_id.localeCompare(b.account_id),
    )
    .slice(0, localSlots)
    .map((candidate) => ({ ...candidate, outreach_lane: "local" as const }));
  const selectedIds = new Set(local.map((candidate) => candidate.account_id));
  const exceptionalPool = reachable
    .filter((candidate) => !selectedIds.has(candidate.account_id))
    .filter((candidate) => activeRadius === null || candidate.distance_km > activeRadius)
    .sort(
      (a, b) =>
        b.score - a.score
        || a.distance_km - b.distance_km
        || a.account_id.localeCompare(b.account_id),
    );
  const exceptional = exceptionalPool
    .slice(0, exceptionalSlots)
    .map((candidate) => ({ ...candidate, outreach_lane: "exceptional" as const }));

  return {
    origin: options.origin,
    active_radius_km: activeRadius,
    local,
    exceptional,
  };
}

export async function fetchDrivingMetrics(
  origin: Coordinates,
  destinations: Array<{ account_id: string; coordinates: Coordinates }>,
  fetchImpl: typeof fetch = fetch,
  batchSize = 49,
): Promise<Map<string, DrivingMetric>> {
  const metrics = new Map<string, DrivingMetric>();
  for (let offset = 0; offset < destinations.length; offset += batchSize) {
    const batch = destinations.slice(offset, offset + batchSize);
    const coordinates = [origin, ...batch.map((destination) => destination.coordinates)]
      .map(([lat, lon]) => `${lon},${lat}`)
      .join(";");
    const response = await fetchImpl(
      `https://router.project-osrm.org/table/v1/driving/${coordinates}?sources=0&annotations=distance,duration`,
      { signal: AbortSignal.timeout(20_000) },
    );
    if (!response.ok) throw new Error(`OSRM table request failed (${response.status})`);
    const payload = await response.json() as {
      code?: string;
      distances?: Array<Array<number | null>>;
      durations?: Array<Array<number | null>>;
    };
    if (payload.code !== "Ok" || !payload.distances?.[0] || !payload.durations?.[0]) {
      throw new Error(`OSRM table response was incomplete (${payload.code || "unknown"})`);
    }
    for (let index = 0; index < batch.length; index += 1) {
      const distance = payload.distances[0][index + 1];
      const duration = payload.durations[0][index + 1];
      if (distance === null || duration === null || !Number.isFinite(distance) || !Number.isFinite(duration)) continue;
      metrics.set(batch[index].account_id, {
        distance_km: Math.round((distance / 1000) * 10) / 10,
        duration_minutes: Math.round(duration / 60),
      });
    }
  }
  return metrics;
}
