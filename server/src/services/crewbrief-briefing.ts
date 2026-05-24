import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import {
  crewbriefTrips,
  crewbriefLegs,
  crewbriefAirports,
  crewbriefAircraft,
  crewbriefDutyDays,
  crewbriefCrewMembers,
  crewbriefDocuments,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { FlightCrewBriefing, BriefingDocument } from "@paperclipai/shared";

const TEMPLATE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../crewbrief-landing/briefing.html",
);

let template: string | null = null;

function loadTemplate(): string | null {
  if (template) return template;
  try {
    template = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    return template;
  } catch {
    return null;
  }
}

export async function getBriefing(
  db: Db,
  tripId: string,
  dutyDayId: string,
): Promise<FlightCrewBriefing | null> {
  const [trip] = await db
    .select()
    .from(crewbriefTrips)
    .where(eq(crewbriefTrips.tripId, tripId))
    .limit(1);
  if (!trip) return null;

  const legs = await db
    .select()
    .from(crewbriefLegs)
    .where(eq(crewbriefLegs.tripId, tripId))
    .orderBy(crewbriefLegs.legNumber);

  const [dutyDay] = dutyDayId
    ? await db.select().from(crewbriefDutyDays).where(eq(crewbriefDutyDays.dutyDayId, dutyDayId)).limit(1)
    : [null];

  const primaryLeg = legs[0] ?? null;
  if (!primaryLeg) return null;

  const [originAirport] = primaryLeg.origin
    ? await db.select().from(crewbriefAirports).where(eq(crewbriefAirports.icao, primaryLeg.origin)).limit(1)
    : [];
  const [destAirport] = primaryLeg.destination
    ? await db.select().from(crewbriefAirports).where(eq(crewbriefAirports.icao, primaryLeg.destination)).limit(1)
    : [];
  const [aircraft] = primaryLeg.aircraftId
    ? await db.select().from(crewbriefAircraft).where(eq(crewbriefAircraft.id, primaryLeg.aircraftId)).limit(1)
    : [];

  const [crewMember] = dutyDay?.crewMemberId
    ? await db.select().from(crewbriefCrewMembers).where(eq(crewbriefCrewMembers.id, dutyDay.crewMemberId)).limit(1)
    : [];

  const docs = await db
    .select()
    .from(crewbriefDocuments)
    .where(eq(crewbriefDocuments.tripId, tripId))
    .orderBy(crewbriefDocuments.uploadedAt);

  const briefingDocuments: BriefingDocument[] = docs.map((d) => ({
    documentId: d.id,
    documentType: d.documentType,
    originalFilename: d.originalFilename,
    parserStatus: d.parserStatus,
    uploadedAt: d.uploadedAt.toISOString(),
    byteSize: d.byteSize,
    sha256: d.sha256,
  }));

  return {
    tripId,
    dutyDayId: dutyDayId ?? "",
    documents: briefingDocuments.length > 0 ? briefingDocuments : undefined,
    overview: {
      flightDate: dutyDay?.dutyDate ?? trip.startDate ?? "",
      departure: originAirport?.icao ?? primaryLeg.origin ?? "",
      arrival: destAirport?.icao ?? primaryLeg.destination ?? "",
      aircraftType: aircraft?.type ?? "",
      flightNumber: primaryLeg.flightNumber ?? "",
      crewPosition: dutyDay?.position ?? crewMember?.role ?? "",
      scheduledDeparture: primaryLeg.scheduledDeparture ?? "",
      scheduledArrival: primaryLeg.scheduledArrival ?? "",
    },
    weather: {
      departure: { station: originAirport?.icao ?? "", metar: "", taf: "" },
      arrival: { station: destAirport?.icao ?? "", metar: "", taf: "" },
      alternate: null,
      enroute: [],
    },
    notams: { departure: [], arrival: [], enroute: [] },
    route: {
      departure: originAirport?.icao ?? "",
      arrival: destAirport?.icao ?? "",
      alternate: primaryLeg.alternate ?? null,
      filedAltitude: primaryLeg.filedAltitude ?? "",
      estimatedTimeEnroute: primaryLeg.estimatedTimeEnroute ?? "",
      fuelOnBoard: primaryLeg.fuelPlan ?? "",
      distance: primaryLeg.distance ?? "",
    },
    alerts: { items: [] },
  };
}

export async function getBriefingHtml(
  db: Db,
  tripId: string,
  dutyDayId: string,
): Promise<string | null> {
  const tpl = loadTemplate();
  if (!tpl) return null;
  const briefing = await getBriefing(db, tripId, dutyDayId);
  if (!briefing) return null;

  const ow = briefing.overview;
  const w = briefing.weather;

  const replacements: Record<string, string> = {
    __TITLE__: `Flight Crew Briefing — ${ow.flightNumber}`,
    __GENERATED_AT__: new Date().toISOString(),
    __FLIGHT_NUMBER__: ow.flightNumber,
    __ORIGIN__: ow.departure,
    __DESTINATION__: ow.arrival,
    __SCHEDULED_DEPARTURE__: ow.scheduledDeparture,
    __SCHEDULED_ARRIVAL__: ow.scheduledArrival,
    __AIRCRAFT_TYPE__: ow.aircraftType,
    __AIRCRAFT_REG__: "",
    __AIRCRAFT_CONFIG__: "",
    __CREW_CAPTAIN__: "",
    __CREW_FO__: "",
    __CREW_PURSER__: "",
    __CREW_CABIN__: "",
    __WX_DEP_STATION__: w.departure.station,
    __WX_DEP_METAR__: w.departure.metar || "N/A",
    __WX_DEP_TAF__: w.departure.taf || "N/A",
    __WX_DEP_CONDITIONS__: w.departure.station ? "Reported" : "N/A",
    __WX_DEP_COND_CLASS__: "bg-gray-200 text-gray-800",
    __WX_DEP_WARNINGS__: "",
    __WX_ARR_STATION__: w.arrival.station,
    __WX_ARR_METAR__: w.arrival.metar || "N/A",
    __WX_ARR_TAF__: w.arrival.taf || "N/A",
    __WX_ARR_CONDITIONS__: w.arrival.station ? "Reported" : "N/A",
    __WX_ARR_COND_CLASS__: "bg-gray-200 text-gray-800",
    __WX_ARR_WARNINGS__: "",
    __WX_ENR_WINDS__: "N/A",
    __WX_ENR_TURB__: "N/A",
    __WX_ENR_ICING__: "N/A",
    __WX_ENR_SIGWX__: "N/A",
    __NOTAMS__: "<p class=\"text-sm text-gray-500 italic\">No NOTAMs</p>",
    __FUEL_PLAN__: briefing.route.fuelOnBoard || "N/A",
    __FUEL_TAXI__: "N/A",
    __FUEL_TRIP__: "N/A",
    __FUEL_CONT__: "N/A",
    __FUEL_ALT__: "N/A",
    __FUEL_RESERVE__: "N/A",
    __FUEL_UNIT__: "lbs",
    __ROUTE__: `${ow.departure} → ${ow.arrival}`,
    __ALTERNATE__: briefing.route.alternate ?? "N/A",
    __RISK_OVERALL__: "N/A",
    __RISK_OVERALL_CLASS__: "bg-gray-200 text-gray-800",
    __RISK_CATEGORIES__: "<p class=\"text-sm text-gray-500 italic\">Risk assessment not available</p>",
  };

  let html = tpl;
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(key, value);
  }
  return html;
}

// Legacy mock generator — preserved as test scaffolding
interface BriefingCrew {
  captain: string; firstOfficer: string; purser: string; cabinCrew: string[];
}
interface BriefingFlight {
  flightNumber: string; origin: string; destination: string;
  scheduledDeparture: string; scheduledArrival: string;
  aircraft: { type: string; registration: string; config: string };
  crew: BriefingCrew;
}
export interface LegacyFlightCrewBriefing {
  id: string; tripId: string; dutyDayId: string;
  title: string; generatedAt: string;
  flight: BriefingFlight;
  weather: {
    departure: { station: string; metar: string; taf: string; conditions: string; warnings: string[] };
    arrival: { station: string; metar: string; taf: string; conditions: string; warnings: string[] };
    enroute: { winds: string; turbulence: string; icing: string; sigwx: string };
  };
  notams: { id: string; type: string; facility: string; text: string; effective: string; until: string }[];
  fuel: { plan: number; taxi: number; trip: number; contingency: number; alternate: number; finalReserve: number; unit: string };
  route: string; alternate: string;
  risk: { overall: string; categories: { name: string; level: string; notes: string }[] };
}

function generateMondayBriefing(tripId: string, dutyDayId: string): LegacyFlightCrewBriefing {
  return {
    id: `${tripId}-${dutyDayId}`, tripId, dutyDayId,
    title: "Monday Flight Crew Briefing",
    generatedAt: new Date().toISOString(),
    flight: {
      flightNumber: "CMF-417", origin: "KLAX", destination: "KJFK",
      scheduledDeparture: "2026-05-25T14:30:00Z", scheduledArrival: "2026-05-25T22:45:00Z",
      aircraft: { type: "Boeing 737-800", registration: "N417CM", config: "Economy 162, Business 16" },
      crew: { captain: "J. Anderson", firstOfficer: "M. Chen", purser: "S. Williams", cabinCrew: ["A. Martinez", "K. Patel"] },
    },
    weather: {
      departure: { station: "KLAX", metar: "KLAX 251150Z 25008KT 10SM FEW025 BKN200 18/14 A2998", taf: "KLAX 251120Z 2512/2618 26010KT P6SM FEW025 BKN200", conditions: "VFR", warnings: ["Crosswind 12G20 knots"] },
      arrival: { station: "KJFK", metar: "KJFK 251150Z 18012KT 6SM -RA BR OVC015 14/12 A2995", taf: "KJFK 251120Z 2512/2618 18012G20KT 5SM -RA BR OVC012", conditions: "MVFR", warnings: ["Low ceiling"] },
      enroute: { winds: "FL370: 26050KT", turbulence: "Light to moderate", icing: "Light icing FL080-FL160", sigwx: "CB TOPS FL420" },
    },
    notams: [
      { id: "N001", type: "Airport", facility: "KLAX", text: "RWY 24L/06R CLSD DUE TO WIP", effective: "2026-05-24T0600Z", until: "2026-05-26T2359Z" },
      { id: "N002", type: "Airport", facility: "KJFK", text: "RWY 13R/31L GROUND MOVEMENT RESTRICTED", effective: "2026-05-25T1200Z", until: "2026-05-25T2359Z" },
    ],
    fuel: { plan: 28500, taxi: 500, trip: 22500, contingency: 2500, alternate: 2000, finalReserve: 1000, unit: "lbs" },
    route: "KLAX DCT SXC LAX J4 TNP J65 BCE J146 ONL J94 FNT J16 PSB J80 HGR J75 HYZ KORRY3 KJFK",
    alternate: "KPHL",
    risk: { overall: "AMBER", categories: [{ name: "Fatigue", level: "GREEN", notes: "Crew rest adequate" }, { name: "Weather", level: "AMBER", notes: "Arrival MVFR" }, { name: "Complexity", level: "GREEN", notes: "Standard route" }, { name: "Crew", level: "GREEN", notes: "Current and qualified" }, { name: "Aircraft", level: "GREEN", notes: "No MEL items" }] },
  };
}

export function renderBriefingHtml(briefing: LegacyFlightCrewBriefing): string | null {
  const tpl = loadTemplate();
  if (!tpl) return null;

  const f = briefing.flight; const w = briefing.weather;
  const notamsHtml = briefing.notams.length > 0
    ? `<div class="space-y-3">${briefing.notams.map(n => `<div class="border-l-4 border-brand-400 bg-gray-50 rounded-r-lg p-3 text-sm"><span class="text-xs font-bold text-gray-500 bg-gray-200 px-1.5 py-0.5 rounded">${n.id}</span><span class="text-xs font-medium text-gray-500 ml-2">${n.type}</span><span class="text-xs font-mono text-gray-400 ml-2">${n.facility}</span><div class="font-medium mt-1">${n.text}</div><div class="text-xs text-gray-400 mt-1">${n.effective} – ${n.until}</div></div>`).join("")}</div>`
    : `<p class="text-sm text-gray-500 italic">No NOTAMs</p>`;

  const riskCategoriesHtml = briefing.risk.categories.map(c =>
    `<div class="border border-gray-200 rounded-lg p-3"><div class="flex items-center justify-between mb-1"><span class="text-sm font-medium">${c.name}</span><span class="text-xs font-bold px-2 py-0.5 rounded ${c.level === "GREEN" ? "bg-green-100 text-green-800" : c.level === "AMBER" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"}">${c.level}</span></div><div class="text-xs text-gray-500">${c.notes}</div></div>`
  ).join("");

  return tpl
    .replace("__TITLE__", briefing.title)
    .replace("__GENERATED_AT__", new Date(briefing.generatedAt).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "full", timeStyle: "short" }) + " UTC")
    .replace("__FLIGHT_NUMBER__", f.flightNumber).replace("__ORIGIN__", f.origin).replace("__DESTINATION__", f.destination)
    .replace("__SCHEDULED_DEPARTURE__", f.scheduledDeparture).replace("__SCHEDULED_ARRIVAL__", f.scheduledArrival)
    .replace("__AIRCRAFT_TYPE__", f.aircraft.type).replace("__AIRCRAFT_REG__", f.aircraft.registration).replace("__AIRCRAFT_CONFIG__", f.aircraft.config)
    .replace("__CREW_CAPTAIN__", f.crew.captain).replace("__CREW_FO__", f.crew.firstOfficer).replace("__CREW_PURSER__", f.crew.purser).replace("__CREW_CABIN__", f.crew.cabinCrew.join(", "))
    .replace("__WX_DEP_METAR__", w.departure.metar).replace("__WX_DEP_TAF__", w.departure.taf).replace("__WX_DEP_STATION__", w.departure.station)
    .replace("__WX_ARR_METAR__", w.arrival.metar).replace("__WX_ARR_TAF__", w.arrival.taf).replace("__WX_ARR_STATION__", w.arrival.station)
    .replace("__WX_ENR_WINDS__", w.enroute.winds).replace("__WX_ENR_TURB__", w.enroute.turbulence).replace("__WX_ENR_ICING__", w.enroute.icing).replace("__WX_ENR_SIGWX__", w.enroute.sigwx)
    .replace("__NOTAMS__", notamsHtml)
    .replace("__FUEL_PLAN__", String(briefing.fuel.plan)).replace("__FUEL_TAXI__", String(briefing.fuel.taxi)).replace("__FUEL_TRIP__", String(briefing.fuel.trip))
    .replace("__FUEL_CONT__", String(briefing.fuel.contingency)).replace("__FUEL_ALT__", String(briefing.fuel.alternate)).replace("__FUEL_RESERVE__", String(briefing.fuel.finalReserve)).replace("__FUEL_UNIT__", briefing.fuel.unit)
    .replace("__ROUTE__", briefing.route).replace("__ALTERNATE__", briefing.alternate)
    .replace("__RISK_OVERALL__", briefing.risk.overall).replace("__RISK_CATEGORIES__", riskCategoriesHtml);
}

export { generateMondayBriefing };
