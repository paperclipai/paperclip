import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface BriefingCrew {
  captain: string;
  firstOfficer: string;
  purser: string;
  cabinCrew: string[];
}

interface BriefingFlight {
  flightNumber: string;
  origin: string;
  destination: string;
  scheduledDeparture: string;
  scheduledArrival: string;
  aircraft: { type: string; registration: string; config: string };
  crew: BriefingCrew;
}

interface BriefingStation {
  station: string;
  metar: string;
  taf: string;
  conditions: string;
  warnings: string[];
}

interface BriefingEnroute {
  winds: string;
  turbulence: string;
  icing: string;
  sigwx: string;
}

interface BriefingNotam {
  id: string;
  type: string;
  facility: string;
  text: string;
  effective: string;
  until: string;
}

interface BriefingFuel {
  plan: number;
  taxi: number;
  trip: number;
  contingency: number;
  alternate: number;
  finalReserve: number;
  unit: string;
}

interface RiskCategory {
  name: string;
  level: string;
  notes: string;
}

interface Risk {
  overall: string;
  categories: RiskCategory[];
}

interface FlightCrewBriefing {
  id: string;
  tripId: string;
  dutyDayId: string;
  title: string;
  generatedAt: string;
  flight: BriefingFlight;
  weather: {
    departure: BriefingStation;
    arrival: BriefingStation;
    enroute: BriefingEnroute;
  };
  notams: BriefingNotam[];
  fuel: BriefingFuel;
  route: string;
  alternate: string;
  risk: Risk;
}

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

function riskClass(level: string): string {
  switch (level.toUpperCase()) {
    case "GREEN": return "risk-green";
    case "AMBER": return "risk-amber";
    case "RED": return "risk-red";
    default: return "bg-gray-200 text-gray-800";
  }
}

function warningBadge(text: string): string {
  return `<div class="flex items-start gap-2 text-sm mt-2"><span class="text-amber-600 shrink-0 mt-0.5">&#9888;</span><span class="text-amber-800">${text}</span></div>`;
}

function renderNotam(notam: BriefingNotam): string {
  return `<div class="border-l-4 ${notam.type === "Airport" ? "border-brand-400" : "border-amber-400"} bg-gray-50 rounded-r-lg p-3 text-sm"><div class="flex items-center gap-2 mb-1"><span class="text-xs font-bold text-gray-500 bg-gray-200 px-1.5 py-0.5 rounded">${notam.id}</span><span class="text-xs font-medium text-gray-500">${notam.type}</span><span class="text-xs font-mono text-gray-400">${notam.facility}</span></div><div class="font-medium">${notam.text}</div><div class="text-xs text-gray-400 mt-1">${notam.effective} &ndash; ${notam.until}</div></div>`;
}

function renderRiskCategory(cat: RiskCategory): string {
  return `<div class="border border-gray-200 rounded-lg p-3"><div class="flex items-center justify-between mb-1"><span class="text-sm font-medium">${cat.name}</span><span class="text-xs font-bold px-2 py-0.5 rounded ${riskClass(cat.level)}">${cat.level}</span></div><div class="text-xs text-gray-500">${cat.notes}</div></div>`;
}

export function renderBriefingHtml(briefing: FlightCrewBriefing): string | null {
  const tpl = loadTemplate();
  if (!tpl) return null;

  const f = briefing.flight;
  const w = briefing.weather;
  const notamsHtml = briefing.notams.length > 0
    ? `<div class="space-y-3">${briefing.notams.map(renderNotam).join("")}</div>`
    : `<p class="text-sm text-gray-500 italic">No NOTAMs</p>`;

  const depWarnings = w.departure.warnings.length > 0
    ? `<div class="mt-2 space-y-1">${w.departure.warnings.map(warningBadge).join("")}</div>`
    : "";
  const arrWarnings = w.arrival.warnings.length > 0
    ? `<div class="mt-2 space-y-1">${w.arrival.warnings.map(warningBadge).join("")}</div>`
    : "";

  const riskCategoriesHtml = briefing.risk.categories.map(renderRiskCategory).join("");

  const replacements: Record<string, string> = {
    __TITLE__: briefing.title,
    __GENERATED_AT__: new Date(briefing.generatedAt).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "full", timeStyle: "short" }) + " UTC",
    __FLIGHT_NUMBER__: f.flightNumber,
    __ORIGIN__: f.origin,
    __DESTINATION__: f.destination,
    __SCHEDULED_DEPARTURE__: new Date(f.scheduledDeparture).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" }) + "Z",
    __SCHEDULED_ARRIVAL__: new Date(f.scheduledArrival).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" }) + "Z",
    __AIRCRAFT_TYPE__: f.aircraft.type,
    __AIRCRAFT_REG__: f.aircraft.registration,
    __AIRCRAFT_CONFIG__: f.aircraft.config,
    __CREW_CAPTAIN__: f.crew.captain,
    __CREW_FO__: f.crew.firstOfficer,
    __CREW_PURSER__: f.crew.purser,
    __CREW_CABIN__: f.crew.cabinCrew.join(", "),
    __WX_DEP_STATION__: w.departure.station,
    __WX_DEP_METAR__: w.departure.metar,
    __WX_DEP_TAF__: w.departure.taf,
    __WX_DEP_CONDITIONS__: w.departure.conditions,
    __WX_DEP_COND_CLASS__: riskClass(w.departure.conditions === "VFR" ? "GREEN" : w.departure.conditions === "MVFR" ? "AMBER" : "RED") + " text-xs font-semibold px-2 py-0.5",
    __WX_DEP_WARNINGS__: depWarnings,
    __WX_ARR_STATION__: w.arrival.station,
    __WX_ARR_METAR__: w.arrival.metar,
    __WX_ARR_TAF__: w.arrival.taf,
    __WX_ARR_CONDITIONS__: w.arrival.conditions,
    __WX_ARR_COND_CLASS__: riskClass(w.arrival.conditions === "VFR" ? "GREEN" : w.arrival.conditions === "MVFR" ? "AMBER" : "RED") + " text-xs font-semibold px-2 py-0.5",
    __WX_ARR_WARNINGS__: arrWarnings,
    __WX_ENR_WINDS__: w.enroute.winds,
    __WX_ENR_TURB__: w.enroute.turbulence,
    __WX_ENR_ICING__: w.enroute.icing,
    __WX_ENR_SIGWX__: w.enroute.sigwx,
    __NOTAMS__: notamsHtml,
    __FUEL_PLAN__: String(briefing.fuel.plan),
    __FUEL_TAXI__: String(briefing.fuel.taxi),
    __FUEL_TRIP__: String(briefing.fuel.trip),
    __FUEL_CONT__: String(briefing.fuel.contingency),
    __FUEL_ALT__: String(briefing.fuel.alternate),
    __FUEL_RESERVE__: String(briefing.fuel.finalReserve),
    __FUEL_UNIT__: briefing.fuel.unit,
    __ROUTE__: briefing.route,
    __ALTERNATE__: briefing.alternate,
    __RISK_OVERALL__: briefing.risk.overall,
    __RISK_OVERALL_CLASS__: riskClass(briefing.risk.overall) + " font-bold",
    __RISK_CATEGORIES__: riskCategoriesHtml,
  };

  let html = tpl;
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(key, value);
  }

  return html;
}

function generateMondayBriefing(tripId: string, dutyDayId: string): FlightCrewBriefing {
  return {
    id: `${tripId}-${dutyDayId}`,
    tripId,
    dutyDayId,
    title: "Monday Flight Crew Briefing",
    generatedAt: new Date().toISOString(),
    flight: {
      flightNumber: "CMF-417",
      origin: "KLAX",
      destination: "KJFK",
      scheduledDeparture: "2026-05-25T14:30:00Z",
      scheduledArrival: "2026-05-25T22:45:00Z",
      aircraft: {
        type: "Boeing 737-800",
        registration: "N417CM",
        config: "Economy 162, Business 16",
      },
      crew: {
        captain: "J. Anderson",
        firstOfficer: "M. Chen",
        purser: "S. Williams",
        cabinCrew: ["A. Martinez", "K. Patel", "R. Thompson", "L. Garcia"],
      },
    },
    weather: {
      departure: {
        station: "KLAX",
        metar: "KLAX 251150Z 25008KT 10SM FEW025 BKN200 18/14 A2998",
        taf: "KLAX 251120Z 2512/2618 26010KT P6SM FEW025 BKN200 FM252000 26012G20KT P6SM FEW030",
        conditions: "VFR",
        warnings: ["Crosswind 12G20 knots after 2000Z"],
      },
      arrival: {
        station: "KJFK",
        metar: "KJFK 251150Z 18012KT 6SM -RA BR OVC015 14/12 A2995",
        taf: "KJFK 251120Z 2512/2618 18012G20KT 5SM -RA BR OVC012 FM260000 22008KT P6SM BKN030",
        conditions: "MVFR",
        warnings: ["Low ceiling OVC012 until 0000Z", "Icing in clouds possible FL080-FL160"],
      },
      enroute: {
        winds: "FL370: 26050KT",
        turbulence: "Light to moderate forecast over Rockies",
        icing: "Light icing FL080-FL160 east of Mississippi",
        sigwx: "WS 251200Z VALID 251200/251800 ZNY ZBW ZDC LINE OF CB TOPS FL420 MOV E 25KT",
      },
    },
    notams: [
      {
        id: "N001",
        type: "Airport",
        facility: "KLAX",
        text: "RWY 24L/06R CLSD DUE TO WIP",
        effective: "2026-05-24T0600Z",
        until: "2026-05-26T2359Z",
      },
      {
        id: "N002",
        type: "Airport",
        facility: "KJFK",
        text: "RWY 13R/31L GROUND MOVEMENT RESTRICTED",
        effective: "2026-05-25T1200Z",
        until: "2026-05-25T2359Z",
      },
      {
        id: "N003",
        type: "Enroute",
        facility: "ZLA",
        text: "AIRSPACE RESERVATION OVER MOJAVE",
        effective: "2026-05-25T1500Z",
        until: "2026-05-25T1800Z",
      },
      {
        id: "N004",
        type: "Enroute",
        facility: "ZAU",
        text: "NAV AID VOR/DME JOT U/S",
        effective: "2026-05-25T0000Z",
        until: "2026-05-30T2359Z",
      },
    ],
    fuel: {
      plan: 28500,
      taxi: 500,
      trip: 22500,
      contingency: 2500,
      alternate: 2000,
      finalReserve: 1000,
      unit: "lbs",
    },
    route: "KLAX DCT SXC LAX J4 TNP J65 BCE J146 ONL J94 FNT J16 PSB J80 HGR J75 HYZ KORRY3 KJFK",
    alternate: "KPHL",
    risk: {
      overall: "AMBER",
      categories: [
        { name: "Fatigue", level: "GREEN", notes: "Crew rest adequate" },
        { name: "Weather", level: "AMBER", notes: "Arrival MVFR, crosswind at departure" },
        { name: "Complexity", level: "GREEN", notes: "Standard route" },
        { name: "Crew", level: "GREEN", notes: "Both pilots current and qualified" },
        { name: "Aircraft", level: "GREEN", notes: "No MEL items" },
      ],
    },
  };
}

export { generateMondayBriefing };
export type { FlightCrewBriefing, BriefingCrew, BriefingFlight, BriefingStation, BriefingEnroute, BriefingNotam, BriefingFuel, RiskCategory, Risk };
