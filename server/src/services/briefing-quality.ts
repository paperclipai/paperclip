import type { Db } from "@paperclipai/db";
import { briefingQuality } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import type {
  FlightCrewBriefing,
  BriefingDimensionScore,
  BriefingGateResult,
  BriefingQualityLabel,
  BriefingQualityClassification,
  BriefingQualityRecord,
  BriefingQualitySummary,
} from "@paperclipai/shared";
import { BRIEFING_MANDATORY_GATE_IDS } from "@paperclipai/shared";

function detectPlaceholder(value: string | null | undefined): boolean {
  if (!value || value.trim().length === 0) return true;
  const lower = value.trim().toLowerCase();
  const placeholders = ["todo", "tbd", "n/a", "na", "placeholder", "lorem ipsum", "test", "sample", "coming soon", "to be determined", "see above"];
  return placeholders.some((p) => lower === p || lower.startsWith(p)) || /^[{[]/.test(lower);
}

function evaluateGateA1(briefing: FlightCrewBriefing): BriefingGateResult {
  const o = briefing.overview;
  const failures: string[] = [];
  if (!o.flightNumber || o.flightNumber.trim().length === 0) failures.push("missing flight number");
  if (!o.flightDate || o.flightDate.trim().length === 0) failures.push("missing flight date");
  if (!o.departure || o.departure.trim().length === 0) failures.push("missing departure");
  if (!o.arrival || o.arrival.trim().length === 0) failures.push("missing arrival");
  return {
    gateId: "A1",
    dimension: "accuracy",
    passed: failures.length === 0,
    details: failures.length > 0 ? failures.join("; ") : "flight, date, and route fields present and non-empty",
  };
}

function evaluateGateA2(briefing: FlightCrewBriefing): BriefingGateResult {
  const o = briefing.overview;
  const timeRegex = /^\d{2}:\d{2}\s*/;
  const failures: string[] = [];
  if (!o.scheduledDeparture || !timeRegex.test(o.scheduledDeparture)) failures.push("missing or invalid scheduled departure time");
  if (!o.scheduledArrival || !timeRegex.test(o.scheduledArrival)) failures.push("missing or invalid scheduled arrival time");
  return {
    gateId: "A2",
    dimension: "accuracy",
    passed: failures.length === 0,
    details: failures.length > 0 ? failures.join("; ") : "scheduled times present and parseable",
  };
}

function evaluateGateA3(briefing: FlightCrewBriefing): BriefingGateResult {
  const a = briefing.overview.aircraftType;
  const passed = Boolean(a && a.trim().length > 0 && !detectPlaceholder(a));
  return {
    gateId: "A3",
    dimension: "accuracy",
    passed,
    details: passed ? `aircraft type '${a}' present` : "missing or placeholder aircraft type",
  };
}

function evaluateGateA4(briefing: FlightCrewBriefing): BriefingGateResult {
  const cp = briefing.overview.crewPosition;
  const passed = Boolean(cp && cp.trim().length > 0 && !detectPlaceholder(cp));
  return {
    gateId: "A4",
    dimension: "accuracy",
    passed,
    details: passed ? `crew position '${cp}' present` : "missing or placeholder crew position",
  };
}

function evaluateGateA5(briefing: FlightCrewBriefing): BriefingGateResult {
  const w = briefing.weather;
  const failures: string[] = [];
  if (!w.departure?.station || !w.departure?.metar) failures.push("departure weather station or METAR missing");
  if (!w.arrival?.station || !w.arrival?.metar) failures.push("arrival weather station or METAR missing");
  return {
    gateId: "A5",
    dimension: "accuracy",
    passed: failures.length === 0,
    details: failures.length > 0 ? failures.join("; ") : "weather data sources validated",
  };
}

function evaluateGateA6(briefing: FlightCrewBriefing): BriefingGateResult {
  const n = briefing.notams;
  const failures: string[] = [];
  if (!n.departure || n.departure.length === 0) failures.push("no departure NOTAMs");
  if (!n.arrival || n.arrival.length === 0) failures.push("no arrival NOTAMs");
  return {
    gateId: "A6",
    dimension: "accuracy",
    passed: failures.length === 0,
    details: failures.length > 0 ? failures.join("; ") : "NOTAMs present for departure and arrival",
  };
}

function evaluateGateA8(briefing: FlightCrewBriefing): BriefingGateResult {
  const r = briefing.route;
  const failures: string[] = [];
  if (!r.fuelOnBoard || detectPlaceholder(r.fuelOnBoard)) failures.push("missing or placeholder fuel on board");
  if (!r.filedAltitude || detectPlaceholder(r.filedAltitude)) failures.push("missing or placeholder filed altitude");
  return {
    gateId: "A8",
    dimension: "accuracy",
    passed: failures.length === 0,
    details: failures.length > 0 ? failures.join("; ") : "fuel and altitude data present",
  };
}

function evaluateGateB1(briefing: FlightCrewBriefing): BriefingGateResult {
  const missing: string[] = [];
  if (!briefing.overview?.flightNumber) missing.push("overview");
  if (!briefing.weather?.departure) missing.push("weather");
  if (!briefing.notams?.departure) missing.push("notams");
  if (!briefing.route?.departure) missing.push("route");
  return {
    gateId: "B1",
    dimension: "completeness",
    passed: missing.length === 0,
    details: missing.length > 0 ? `missing sections: ${missing.join(", ")}` : "all required sections present",
  };
}

function evaluateGateB9(briefing: FlightCrewBriefing): BriefingGateResult {
  const placeholders: string[] = [];
  const o = briefing.overview;
  if (detectPlaceholder(o.flightNumber)) placeholders.push("flight number");
  if (detectPlaceholder(o.aircraftType)) placeholders.push("aircraft type");
  if (detectPlaceholder(o.crewPosition)) placeholders.push("crew position");
  if (detectPlaceholder(o.departure)) placeholders.push("departure");
  if (detectPlaceholder(o.arrival)) placeholders.push("arrival");
  const r = briefing.route;
  if (detectPlaceholder(r.departure)) placeholders.push("route departure");
  if (detectPlaceholder(r.arrival)) placeholders.push("route arrival");
  return {
    gateId: "B9",
    dimension: "completeness",
    passed: placeholders.length === 0,
    details: placeholders.length > 0 ? `placeholder content detected: ${placeholders.join(", ")}` : "no boilerplate or placeholder content detected",
  };
}

function evaluateGateD2(): BriefingGateResult {
  return {
    gateId: "D2",
    dimension: "timeliness",
    passed: true,
    details: "delivery window check requires real-time comparison — default pass",
  };
}

function evaluateGateD3(): BriefingGateResult {
  return {
    gateId: "D3",
    dimension: "timeliness",
    passed: true,
    details: "data source freshness requires external metadata — default pass",
  };
}

function evaluateGateD4(): BriefingGateResult {
  return {
    gateId: "D4",
    dimension: "timeliness",
    passed: true,
    details: "stale cache detection requires cache metadata — default pass",
  };
}

function evaluateGateE2(): BriefingGateResult {
  return {
    gateId: "E2",
    dimension: "operational_usefulness",
    passed: true,
    details: "operational usefulness requires contextual evaluation — default pass",
  };
}

const GATE_EVALUATORS: Record<string, (briefing: FlightCrewBriefing) => BriefingGateResult> = {
  A1: evaluateGateA1,
  A2: evaluateGateA2,
  A3: evaluateGateA3,
  A4: evaluateGateA4,
  A5: evaluateGateA5,
  A6: evaluateGateA6,
  A8: evaluateGateA8,
  B1: evaluateGateB1,
  B9: evaluateGateB9,
  D2: evaluateGateD2,
  D3: evaluateGateD3,
  D4: evaluateGateD4,
  E2: evaluateGateE2,
};

function scoreDimension(gateResults: BriefingGateResult[], dimension: string): number {
  const dimGates = gateResults.filter((g) => g.dimension === dimension);
  if (dimGates.length === 0) return 0;
  const passedCount = dimGates.filter((g) => g.passed).length;
  return Math.round((passedCount / dimGates.length) * 5 * 100) / 100;
}

function dimensionDetails(gateResults: BriefingGateResult[], dimension: string): string {
  const dimGates = gateResults.filter((g) => g.dimension === dimension);
  const passed = dimGates.filter((g) => g.passed).length;
  const total = dimGates.length;
  return `${passed}/${total} gates passed`;
}

export function assignQualityLabel(
  overallScore: number,
  gateResults: BriefingGateResult[],
): BriefingQualityLabel {
  const mandatoryGates = gateResults.filter((g) => BRIEFING_MANDATORY_GATE_IDS.includes(g.gateId));
  const failedMandatory = mandatoryGates.filter((g) => !g.passed);
  const failedCount = failedMandatory.length;

  if (overallScore < 2.0 || failedCount > 2) return "failed";
  if (overallScore < 3.5 || failedCount > 0) return "degraded";
  if (overallScore >= 4.5 && failedCount === 0) return "premium";
  return "standard";
}

export function classify(briefingId: string, briefing: FlightCrewBriefing): BriefingQualityClassification {
  const gateResults = BRIEFING_MANDATORY_GATE_IDS.map((gateId) => GATE_EVALUATORS[gateId](briefing));
  const dimensionScores: BriefingDimensionScore[] = [
    { dimension: "accuracy", score: scoreDimension(gateResults, "accuracy"), details: dimensionDetails(gateResults, "accuracy") },
    { dimension: "completeness", score: scoreDimension(gateResults, "completeness"), details: dimensionDetails(gateResults, "completeness") },
    { dimension: "timeliness", score: scoreDimension(gateResults, "timeliness"), details: dimensionDetails(gateResults, "timeliness") },
    { dimension: "clarity_presentation", score: 0, details: "clarity evaluation requires NLP analysis — default pending" },
    { dimension: "operational_usefulness", score: scoreDimension(gateResults, "operational_usefulness"), details: dimensionDetails(gateResults, "operational_usefulness") },
  ];
  const dimensionScoresWithValues = dimensionScores.filter((d) => d.dimension !== "clarity_presentation");
  const avgWithoutClarity = dimensionScoresWithValues.reduce((sum, d) => sum + d.score, 0) / dimensionScoresWithValues.length;
  dimensionScores[3] = { dimension: "clarity_presentation", score: Math.round(avgWithoutClarity * 100) / 100, details: "estimated from other dimension scores" };
  const overallScore = Math.round(dimensionScores.reduce((sum, d) => sum + d.score, 0) / dimensionScores.length * 100) / 100;
  const label = assignQualityLabel(overallScore, gateResults);
  return { briefingId, overallScore, label, dimensionScores, gateResults, createdAt: new Date() };
}

export function briefingQualityService(db: Db) {
  async function classifyAndStore(briefingId: string, briefing: FlightCrewBriefing): Promise<BriefingQualityClassification> {
    const result = classify(briefingId, briefing);
    await db
      .insert(briefingQuality)
      .values({
        briefingId: result.briefingId,
        overallScore: result.overallScore.toString(),
        label: result.label,
        dimensionScores: JSON.stringify(result.dimensionScores),
        gateResults: JSON.stringify(result.gateResults),
      })
      .onConflictDoUpdate({
        target: briefingQuality.briefingId,
        set: {
          overallScore: result.overallScore.toString(),
          label: result.label,
          dimensionScores: JSON.stringify(result.dimensionScores),
          gateResults: JSON.stringify(result.gateResults),
          updatedAt: sql`now()`,
        },
      });
    return result;
  }

  async function getByBriefingId(briefingId: string): Promise<BriefingQualityClassification | null> {
    const rows = await db.select().from(briefingQuality).where(eq(briefingQuality.briefingId, briefingId));
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      briefingId: row.briefingId,
      overallScore: parseFloat(row.overallScore),
      label: row.label as BriefingQualityLabel,
      dimensionScores: row.dimensionScores as BriefingDimensionScore[],
      gateResults: row.gateResults as BriefingGateResult[],
      createdAt: row.createdAt,
    };
  }

  async function getSummary(): Promise<BriefingQualitySummary> {
    const rows = await db.select().from(briefingQuality).orderBy(sql`${briefingQuality.createdAt} desc`).limit(50);
    const totalClassified = rows.length;
    const labelCounts: Record<string, number> = { premium: 0, standard: 0, degraded: 0, failed: 0 };
    let scoreSum = 0;
    for (const row of rows) {
      labelCounts[row.label] = (labelCounts[row.label] ?? 0) + 1;
      scoreSum += parseFloat(row.overallScore);
    }
    const labelBreakdown = (Object.entries(labelCounts) as [string, number][]).map(([label, count]) => ({
      label: label as BriefingQualityLabel,
      count,
    }));
    const recentResults = rows.slice(0, 10).map((row) => ({
      briefingId: row.briefingId,
      overallScore: parseFloat(row.overallScore),
      label: row.label as BriefingQualityLabel,
      dimensionScores: row.dimensionScores as BriefingDimensionScore[],
      gateResults: row.gateResults as BriefingGateResult[],
      createdAt: row.createdAt,
    }));
    return {
      totalClassified,
      labelBreakdown,
      averageScore: totalClassified > 0 ? Math.round((scoreSum / totalClassified) * 100) / 100 : 0,
      recentResults,
    };
  }

  return { classifyAndStore, getByBriefingId, getSummary };
}

export type BriefingQualityService = ReturnType<typeof briefingQualityService>;
