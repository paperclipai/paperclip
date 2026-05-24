import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import {
  crewbriefAirports,
  crewbriefAircraft,
  crewbriefCrewMembers,
  crewbriefTrips,
  crewbriefLegs,
  crewbriefDutyDays,
  crewbriefDocuments,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import type { StorageService } from "../storage/types.js";
import { parseItinerary, extractPdfText, type ParsedItinerary, type ExtractionCounts } from "../services/crewbrief-jetinsight.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import type { ParseInput, ParseResult } from "../services/crewbrief-document-registry.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
});

async function runSingleFileUpload(req: Request, res: Response): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function assertCompanyAccess(_req: Request, _companyId: string): void {
}

async function upsertAirport(
  db: Db,
  icao: string,
): Promise<void> {
  await db
    .insert(crewbriefAirports)
    .values({
      icao,
      name: icao,
    })
    .onConflictDoNothing({ target: crewbriefAirports.icao });
}

async function upsertAircraft(
  db: Db,
  registration: string,
): Promise<string | null> {
  const [existing] = await db
    .select()
    .from(crewbriefAircraft)
    .where(eq(crewbriefAircraft.registration, registration))
    .limit(1);
  if (existing) return existing.id;

  const [inserted] = await db
    .insert(crewbriefAircraft)
    .values({
      type: "unknown",
      registration,
    })
    .onConflictDoNothing({ target: crewbriefAircraft.registration })
    .returning();

  return inserted?.id ?? null;
}

async function upsertCrewMember(
  db: Db,
  employeeId: string,
): Promise<string | null> {
  const [existing] = await db
    .select()
    .from(crewbriefCrewMembers)
    .where(eq(crewbriefCrewMembers.employeeId, employeeId))
    .limit(1);
  if (existing) return existing.id;

  const [inserted] = await db
    .insert(crewbriefCrewMembers)
    .values({
      employeeId,
      name: employeeId,
      role: "crew",
    })
    .onConflictDoNothing({ target: crewbriefCrewMembers.employeeId })
    .returning();

  return inserted?.id ?? null;
}

export function crewbriefJetinsightRoutes(db: Db, storage: StorageService) {
  const router = Router();

  router.post("/parse", async (req, res, next) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "text field is required" });
        return;
      }

      const parsed = await parseItinerary(text);

      const counts = await storeParsedData(db, parsed);

      res.status(201).json({ trip: { tripId: parsed.tripId }, parsed, counts });
    } catch (err) {
      next(err);
    }
  });

  const uploadHandler = createUploadHandler(db, storage);
  router.post("/upload", uploadHandler);

  return router;
}

export function crewbriefDocumentsRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const handler = createUploadHandler(db, storage);
  router.post("/upload", handler);
  return router;
}

function createUploadHandler(db: Db, storage: StorageService) {
  return async (req: Request, res: Response, next: any) => {
    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `File exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
      return;
    }

    try {
      const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
      if (!file) {
        res.status(400).json({ error: "Missing file field 'file'" });
        return;
      }

      const contentType = (file.mimetype || "").toLowerCase();
      if (contentType !== "application/pdf" && !isAllowedContentType(contentType)) {
        res.status(422).json({ error: `Unsupported file type: ${contentType || "unknown"}` });
        return;
      }

      let companyId = req.headers["x-company-id"] as string;
      if (!companyId) {
        companyId = "default";
      }
      const actor = (req as Record<string, unknown>).actor as
        | { agentId?: string; agentType?: string; actorType?: string; actorId?: string }
        | undefined;

      const text = await extractPdfText(file.buffer);

      const parsed = await parseItinerary(text);

      const stored = await storage.putFile({
        companyId,
        namespace: "crewbrief-jetinsight",
        originalFilename: file.originalname || null,
        contentType,
        body: file.buffer,
      });

      const docTripId = parsed.tripId;

      await db.insert(crewbriefDocuments).values({
        tripId: docTripId,
        dutyDayId: null,
        aircraftTail: parsed.legs[0]?.aircraftRegistration ?? null,
        documentType: "crew_itinerary",
        originalFilename: file.originalname || "upload.pdf",
        storageObjectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        parserStatus: "parsing",
      }).execute();

      const [docRecord] = await db
        .select()
        .from(crewbriefDocuments)
        .where(eq(crewbriefDocuments.storageObjectKey, stored.objectKey))
        .limit(1);

      const documentId = docRecord?.id;

      try {
        const counts = await storeParsedData(db, parsed);

        if (documentId) {
          await db
            .update(crewbriefDocuments)
            .set({
              parserStatus: "completed",
              extractionStatus: sql`${JSON.stringify(counts)}::jsonb`,
              parsedAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(eq(crewbriefDocuments.id, documentId));
        }

        res.status(201).json({
          documentId,
          trip: { tripId: parsed.tripId },
          parsed,
          counts,
          storage: {
            objectKey: stored.objectKey,
            sha256: stored.sha256,
            byteSize: stored.byteSize,
          },
        });
      } catch (parseErr) {
        const message = parseErr instanceof Error ? parseErr.message : "Parse failed";
        if (documentId) {
          await db
            .update(crewbriefDocuments)
            .set({
              parserStatus: "failed",
              errorDetails: message,
              updatedAt: sql`now()`,
            })
            .where(eq(crewbriefDocuments.id, documentId));
        }
        throw parseErr;
      }
    } catch (err) {
      next(err);
    }
  };
}

async function storeParsedData(db: Db, parsed: ParsedItinerary): Promise<ExtractionCounts> {
  const counts: ExtractionCounts = { trips: 0, legs: 0, crewMembers: 0, aircraft: 0, airports: 0 };

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
  if (trip) counts.trips = 1;

  const seenAirports = new Set<string>();
  const seenAircraft = new Set<string>();

  for (const leg of parsed.legs) {
    if (leg.origin && !seenAirports.has(leg.origin)) {
      seenAirports.add(leg.origin);
      await upsertAirport(db, leg.origin);
      counts.airports++;
    }
    if (leg.destination && !seenAirports.has(leg.destination)) {
      seenAirports.add(leg.destination);
      await upsertAirport(db, leg.destination);
      counts.airports++;
    }
    if (leg.alternate && !seenAirports.has(leg.alternate)) {
      seenAirports.add(leg.alternate);
      await upsertAirport(db, leg.alternate);
      counts.airports++;
    }

    let aircraftId: string | null = null;
    if (leg.aircraftRegistration && !seenAircraft.has(leg.aircraftRegistration)) {
      seenAircraft.add(leg.aircraftRegistration);
      aircraftId = await upsertAircraft(db, leg.aircraftRegistration);
      if (aircraftId) counts.aircraft++;
    } else if (leg.aircraftRegistration) {
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
    counts.legs++;
  }

  if (parsed.crewAssignments) {
    for (const assignment of parsed.crewAssignments) {
      let crewMemberId: string | null = null;
      crewMemberId = await upsertCrewMember(db, assignment.employeeId);
      if (crewMemberId) counts.crewMembers++;

      await db
        .insert(crewbriefDutyDays)
        .values({
          dutyDayId: assignment.dutyDayId,
          tripId: parsed.tripId,
          crewMemberId,
          dutyDate: assignment.dutyDate,
          position: assignment.position ?? null,
          reportTime: assignment.reportTime ?? null,
          releaseTime: assignment.releaseTime ?? null,
        })
        .onConflictDoUpdate({
          target: crewbriefDutyDays.dutyDayId,
          set: {
            crewMemberId,
            dutyDate: assignment.dutyDate,
            position: assignment.position ?? null,
            reportTime: assignment.reportTime ?? null,
            releaseTime: assignment.releaseTime ?? null,
          },
        });
    }
  }

  return counts;
}

export async function parseCrewItineraryDocument(input: ParseInput): Promise<ParseResult> {
  try {
    const text = await extractPdfText(input.buffer);
    const parsed = await parseItinerary(text);
    const counts = await storeParsedData(input.db, parsed);
    return { success: true, summary: counts as unknown as Record<string, unknown> };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown parse error" };
  }
}
