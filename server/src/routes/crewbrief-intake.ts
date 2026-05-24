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
  batchAirportSchema,
  batchAircraftSchema,
  batchCrewMemberSchema,
  batchTripCreateSchema,
} from "@paperclipai/shared";

function intakeAuth(_db: Db): Router {
  const router = Router();
  const apiKey = process.env.CREWBRIEF_INTAKE_API_KEY;
  router.use((req, _res, next) => {
    if (!apiKey) {
      next();
      return;
    }
    const provided = req.headers["x-intake-api-key"];
    if (provided !== apiKey) {
      _res.status(401).json({ error: "Unauthorized: invalid or missing intake API key" });
      return;
    }
    next();
  });
  return router;
}

export function crewbriefIntakeRoutes(db: Db) {
  const router = Router();
  router.use(intakeAuth(db));

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

  router.post("/batch/airports", validate(batchAirportSchema), async (req, res) => {
    const results: Array<{ icao: string; action: "created" | "updated" }> = [];
    const errors: Array<{ icao: string; error: string }> = [];

    for (const airport of req.body.airports) {
      try {
        const existing = await db
          .select()
          .from(crewbriefAirports)
          .where(eq(crewbriefAirports.icao, airport.icao))
          .limit(1);

        if (existing.length > 0) {
          await db
            .update(crewbriefAirports)
            .set({ ...airport, updatedAt: sql`now()` })
            .where(eq(crewbriefAirports.icao, airport.icao));
          results.push({ icao: airport.icao, action: "updated" });
        } else {
          await db.insert(crewbriefAirports).values(airport);
          results.push({ icao: airport.icao, action: "created" });
        }
      } catch (err) {
        errors.push({ icao: airport.icao, error: (err as Error).message });
      }
    }

    res.status(201).json({ results, errors, total: req.body.airports.length, succeeded: results.length, failed: errors.length });
  });

  router.post("/batch/aircraft", validate(batchAircraftSchema), async (req, res) => {
    const results: Array<{ registration: string; action: "created" | "updated" }> = [];
    const errors: Array<{ registration: string; error: string }> = [];

    for (const ac of req.body.aircraft) {
      try {
        const existing = await db
          .select()
          .from(crewbriefAircraft)
          .where(eq(crewbriefAircraft.registration, ac.registration))
          .limit(1);

        if (existing.length > 0) {
          await db
            .update(crewbriefAircraft)
            .set({ ...ac, updatedAt: sql`now()` })
            .where(eq(crewbriefAircraft.registration, ac.registration));
          results.push({ registration: ac.registration, action: "updated" });
        } else {
          await db.insert(crewbriefAircraft).values(ac);
          results.push({ registration: ac.registration, action: "created" });
        }
      } catch (err) {
        errors.push({ registration: ac.registration, error: (err as Error).message });
      }
    }

    res.status(201).json({ results, errors, total: req.body.aircraft.length, succeeded: results.length, failed: errors.length });
  });

  router.post("/batch/crew-members", validate(batchCrewMemberSchema), async (req, res) => {
    const results: Array<{ employeeId: string; action: "created" | "updated" }> = [];
    const errors: Array<{ employeeId: string; error: string }> = [];

    for (const cm of req.body.crewMembers) {
      try {
        const existing = await db
          .select()
          .from(crewbriefCrewMembers)
          .where(eq(crewbriefCrewMembers.employeeId, cm.employeeId))
          .limit(1);

        if (existing.length > 0) {
          await db
            .update(crewbriefCrewMembers)
            .set({ ...cm, updatedAt: sql`now()` })
            .where(eq(crewbriefCrewMembers.employeeId, cm.employeeId));
          results.push({ employeeId: cm.employeeId, action: "updated" });
        } else {
          await db.insert(crewbriefCrewMembers).values(cm);
          results.push({ employeeId: cm.employeeId, action: "created" });
        }
      } catch (err) {
        errors.push({ employeeId: cm.employeeId, error: (err as Error).message });
      }
    }

    res.status(201).json({ results, errors, total: req.body.crewMembers.length, succeeded: results.length, failed: errors.length });
  });

  router.post("/batch/trips", validate(batchTripCreateSchema), async (req, res) => {
    const results: Array<{ tripId: string; action: "created" | "updated" }> = [];
    const errors: Array<{ tripId: string; error: string }> = [];

    for (const tripInput of req.body.trips) {
      try {
        const { tripId, airline, startDate, endDate, legs, crewAssignments } = tripInput;

        await db
          .insert(crewbriefTrips)
          .values({ tripId, airline, startDate, endDate })
          .onConflictDoUpdate({
            target: crewbriefTrips.tripId,
            set: { airline, startDate, endDate, updatedAt: sql`now()` },
          });

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

        results.push({ tripId, action: "created" });
      } catch (err) {
        errors.push({ tripId: tripInput.tripId, error: (err as Error).message });
      }
    }

    res.status(201).json({ results, errors, total: req.body.trips.length, succeeded: results.length, failed: errors.length });
  });

  return router;
}
