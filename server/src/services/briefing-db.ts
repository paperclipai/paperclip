import type { Db } from "@paperclipai/db";
import type { FlightCrewBriefing } from "@paperclipai/shared";
import { briefingGenerationService } from "./briefing-generation.js";
import { renderBriefingHtml, generateMondayBriefing } from "./crewbrief-briefing.js";

const svc = briefingGenerationService();

export async function getBriefing(db: Db, tripId: string, dutyDayId: string): Promise<FlightCrewBriefing | null> {
  return svc.generate(tripId, dutyDayId);
}

export async function getBriefingHtml(db: Db, tripId: string, dutyDayId: string): Promise<string | null> {
  const legacy = generateMondayBriefing(tripId, dutyDayId);
  return renderBriefingHtml(legacy);
}
