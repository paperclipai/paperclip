import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  crewbriefAirports,
  crewbriefAircraft,
  crewbriefCrewMembers,
  crewbriefTrips,
  crewbriefLegs,
  crewbriefDutyDays,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { validate } from "../middleware/validate.js";
import {
  airportSchema,
  aircraftSchema,
  crewMemberSchema,
  tripCreateSchema,
} from "@paperclipai/shared";

export function crewbriefIntakeRoutes(db: Db) {
  const router = Router();

  router.post("/airports", validate(airportSchema), async (req, res) => {
    const existing = await db
      .select()
      .from(crewbriefAirports)
      .where(eq(crewbriefAirports.icao, req.body.icao))
      .limit(1);

    if (existing.length > 0) {
      const [updated] = await db
        .update(crewbriefAirports)
        .set({ ...req.body, updatedAt: sql`now()` })
        .where(eq(crewbriefAirports.icao, req.body.icao))
        .returning();
      res.json(updated);
      return;
    }

    const [created] = await db
      .insert(crewbriefAirports)
      .values(req.body)
      .returning();
    res.status(201).json(created);
  });

  router.post("/aircraft", validate(aircraftSchema), async (req, res) => {
    const existing = await db
      .select()
      .from(crewbriefAircraft)
      .where(eq(crewbriefAircraft.registration, req.body.registration))
      .limit(1);

    if (existing.length > 0) {
      const [updated] = await db
        .update(crewbriefAircraft)
        .set({ ...req.body, updatedAt: sql`now()` })
        .where(eq(crewbriefAircraft.registration, req.body.registration))
        .returning();
      res.json(updated);
      return;
    }

    const [created] = await db
      .insert(crewbriefAircraft)
      .values(req.body)
      .returning();
    res.status(201).json(created);
  });

  router.post("/crew-members", validate(crewMemberSchema), async (req, res) => {
    const existing = await db
      .select()
      .from(crewbriefCrewMembers)
      .where(eq(crewbriefCrewMembers.employeeId, req.body.employeeId))
      .limit(1);

    if (existing.length > 0) {
      const [updated] = await db
        .update(crewbriefCrewMembers)
        .set({ ...req.body, updatedAt: sql`now()` })
        .where(eq(crewbriefCrewMembers.employeeId, req.body.employeeId))
        .returning();
      res.json(updated);
      return;
    }

    const [created] = await db
      .insert(crewbriefCrewMembers)
      .values(req.body)
      .returning();
    res.status(201).json(created);
  });

  router.post("/trips", validate(tripCreateSchema), async (req, res) => {
    const { tripId, airline, startDate, endDate, legs, crewAssignments } = req.body;

    const [trip] = await db
      .insert(crewbriefTrips)
      .values({ tripId, airline, startDate, endDate })
      .onConflictDoUpdate({
        target: crewbriefTrips.tripId,
        set: { airline, startDate, endDate, updatedAt: sql`now()` },
      })
      .returning();

    for (const leg of legs) {
      let aircraftId = null;
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
          tripId,
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

    if (crewAssignments) {
      for (const assignment of crewAssignments) {
        const [crew] = await db
          .select()
          .from(crewbriefCrewMembers)
          .where(eq(crewbriefCrewMembers.employeeId, assignment.employeeId))
          .limit(1);

        await db
          .insert(crewbriefDutyDays)
          .values({
            dutyDayId: assignment.dutyDayId,
            tripId,
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

    res.status(201).json(trip);
  });

  return router;
}
