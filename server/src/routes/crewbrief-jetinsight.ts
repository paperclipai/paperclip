import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  crewbriefAircraft,
  crewbriefCrewMembers,
  crewbriefTrips,
  crewbriefLegs,
  crewbriefDutyDays,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { parseItinerary } from "../services/crewbrief-jetinsight.js";

export function crewbriefJetinsightRoutes(db: Db) {
  const router = Router();

  router.post("/parse", async (req, res, next) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "text field is required" });
        return;
      }

      const parsed = await parseItinerary(text);

      const [trip] = await db
        .insert(crewbriefTrips)
        .values({
          tripId: parsed.tripId,
          airline: parsed.airline ?? null,
          startDate: parsed.startDate ?? null,
          endDate: parsed.endDate ?? null,
        })
        .onConflictDoUpdate({
          target: crewbriefTrips.tripId,
          set: {
            airline: parsed.airline ?? null,
            startDate: parsed.startDate ?? null,
            endDate: parsed.endDate ?? null,
            updatedAt: sql`now()`,
          },
        })
        .returning();

      for (const leg of parsed.legs) {
        let aircraftId: string | null = null;
        if (leg.aircraftRegistration) {
          const [ac] = await db
            .select()
            .from(crewbriefAircraft)
            .where(eq(crewbriefAircraft.registration, leg.aircraftRegistration))
            .limit(1);
          if (ac) aircraftId = ac.id;
        }

        await db
          .insert(crewbriefLegs)
          .values({
            tripId: parsed.tripId,
            legNumber: leg.legNumber,
            flightNumber: leg.flightNumber,
            origin: leg.origin,
            destination: leg.destination,
            alternate: leg.alternate ?? null,
            scheduledDeparture: leg.scheduledDeparture ?? null,
            scheduledArrival: leg.scheduledArrival ?? null,
            aircraftId,
            filedAltitude: leg.filedAltitude ?? null,
            estimatedTimeEnroute: leg.estimatedTimeEnroute ?? null,
            distance: leg.distance ?? null,
            fuelPlan: leg.fuelPlan ?? null,
            fuelUnit: leg.fuelUnit ?? "lbs",
          })
          .onConflictDoNothing({ target: crewbriefLegs.id });
      }

      if (parsed.crewAssignments) {
        for (const assignment of parsed.crewAssignments) {
          const [crew] = await db
            .select()
            .from(crewbriefCrewMembers)
            .where(eq(crewbriefCrewMembers.employeeId, assignment.employeeId))
            .limit(1);

          await db
            .insert(crewbriefDutyDays)
            .values({
              dutyDayId: assignment.dutyDayId,
              tripId: parsed.tripId,
              crewMemberId: crew?.id ?? null,
              dutyDate: assignment.dutyDate,
              position: assignment.position ?? null,
              reportTime: assignment.reportTime ?? null,
              releaseTime: assignment.releaseTime ?? null,
            })
            .onConflictDoUpdate({
              target: crewbriefDutyDays.dutyDayId,
              set: {
                crewMemberId: crew?.id ?? null,
                dutyDate: assignment.dutyDate,
                position: assignment.position ?? null,
                reportTime: assignment.reportTime ?? null,
                releaseTime: assignment.releaseTime ?? null,
              },
            });
        }
      }

      res.status(201).json({ trip, parsed });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
