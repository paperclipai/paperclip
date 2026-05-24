import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import { crewbriefDocuments } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import type { StorageService } from "../storage/types.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import {
  getParser,
  isRegisteredType,
  type DocumentType,
} from "../services/crewbrief-document-registry.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
});

function getCompanyId(req: Request): string {
  return (req.headers["x-company-id"] as string) || "default";
}

function assertCompanyAccess(_req: Request, _companyId: string): void {
}

export function crewbriefDocumentsRoutes(db: Db, storage: StorageService) {
  const router = Router();

  router.post("/upload", async (req, res, next) => {
    try {
      await new Promise<void>((resolve, reject) => {
        upload.single("file")(req, res, (err: unknown) => {
          if (err) reject(err);
          else resolve();
        });
      });
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

      const { tripId, dutyDayId, aircraftTail, documentType } = req.body as Record<string, string | undefined>;
      if (!tripId || typeof tripId !== "string") {
        res.status(400).json({ error: "tripId is required" });
        return;
      }

      const docType: DocumentType = (documentType as DocumentType) || "crew_itinerary";

      const companyId = getCompanyId(req);
      assertCompanyAccess(req, companyId);

      const stored = await storage.putFile({
        companyId,
        namespace: "crewbrief-documents",
        originalFilename: file.originalname || null,
        contentType,
        body: file.buffer,
      });

      const [doc] = await db
        .insert(crewbriefDocuments)
        .values({
          tripId,
          dutyDayId: dutyDayId || null,
          aircraftTail: aircraftTail || null,
          documentType: docType,
          originalFilename: file.originalname || "upload.pdf",
          storageObjectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          parserStatus: "pending",
        })
        .returning();

      if (isRegisteredType(docType)) {
        await db
          .update(crewbriefDocuments)
          .set({ parserStatus: "parsing", updatedAt: sql`now()` })
          .where(eq(crewbriefDocuments.id, doc.id));

        const parser = getParser(docType)!;
        const result = await parser({
          db,
          buffer: file.buffer,
          documentId: doc.id,
          metadata: {
            tripId,
            dutyDayId: dutyDayId || null,
            aircraftTail: aircraftTail || null,
            documentType: docType,
          },
        });

        if (result.success) {
          await db
            .update(crewbriefDocuments)
            .set({
              parserStatus: "completed",
              extractionStatus: result.summary ? sql`${JSON.stringify(result.summary)}::jsonb` : null,
              parsedAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(eq(crewbriefDocuments.id, doc.id));
        } else {
          await db
            .update(crewbriefDocuments)
            .set({
              parserStatus: "failed",
              errorDetails: result.error || "Parser returned no error details",
              updatedAt: sql`now()`,
            })
            .where(eq(crewbriefDocuments.id, doc.id));
        }
      }

      res.status(201).json({
        documentId: doc.id,
        documentType: docType,
        storage: {
          objectKey: stored.objectKey,
          sha256: stored.sha256,
          byteSize: stored.byteSize,
        },
        parserStatus: isRegisteredType(docType) ? "completed" : "pending",
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:documentId/parse", async (req, res, next) => {
    try {
      const { documentId } = req.params;

      const [doc] = await db
        .select()
        .from(crewbriefDocuments)
        .where(eq(crewbriefDocuments.id, documentId))
        .limit(1);

      if (!doc) {
        res.status(404).json({ error: "Document not found" });
        return;
      }

      if (!isRegisteredType(doc.documentType)) {
        res.status(400).json({ error: `No parser registered for document type: ${doc.documentType}` });
        return;
      }

      await db
        .update(crewbriefDocuments)
        .set({ parserStatus: "parsing", updatedAt: sql`now()` })
        .where(eq(crewbriefDocuments.id, doc.id));

      const companyId = getCompanyId(req);
      const obj = await storage.getObject(companyId, doc.storageObjectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of obj.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);

      const parser = getParser(doc.documentType)!;
      const result = await parser({
        db,
        buffer,
        documentId: doc.id,
        metadata: {
          tripId: doc.tripId,
          dutyDayId: doc.dutyDayId,
          aircraftTail: doc.aircraftTail,
          documentType: doc.documentType as DocumentType,
        },
      });

      if (result.success) {
        await db
          .update(crewbriefDocuments)
          .set({
            parserStatus: "completed",
            extractionStatus: result.summary ? sql`${JSON.stringify(result.summary)}::jsonb` : null,
            parsedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(crewbriefDocuments.id, doc.id));
      } else {
        await db
          .update(crewbriefDocuments)
          .set({
            parserStatus: "failed",
            errorDetails: result.error || "Reparse failed",
            updatedAt: sql`now()`,
          })
          .where(eq(crewbriefDocuments.id, doc.id));
      }

      res.json({
        documentId: doc.id,
        parserStatus: result.success ? "completed" : "failed",
        summary: result.summary,
        error: result.error,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:documentId", async (req, res, next) => {
    try {
      const { documentId } = req.params;

      const [doc] = await db
        .select()
        .from(crewbriefDocuments)
        .where(eq(crewbriefDocuments.id, documentId))
        .limit(1);

      if (!doc) {
        res.status(404).json({ error: "Document not found" });
        return;
      }

      res.json({
        documentId: doc.id,
        tripId: doc.tripId,
        dutyDayId: doc.dutyDayId,
        aircraftTail: doc.aircraftTail,
        documentType: doc.documentType,
        originalFilename: doc.originalFilename,
        byteSize: doc.byteSize,
        sha256: doc.sha256,
        parserStatus: doc.parserStatus,
        extractionStatus: doc.extractionStatus,
        errorDetails: doc.errorDetails,
        uploadedAt: doc.uploadedAt,
        parsedAt: doc.parsedAt,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
