import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { and, eq, not, inArray } from "drizzle-orm";
import { validate } from "../middleware/validate.js";
import { quickNoteService } from "../services/quick-notes.js";
import { heartbeatService } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const createSchema = z.object({
  text: z.string().min(1).max(4000),
  metadata: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  text: z.string().min(1).max(4000).optional(),
  status: z.enum(["new", "researching", "has_suggestions", "dismissed"]).optional(),
  dismissed: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const threadSchema = z.object({
  body: z.string().min(1).max(8000),
});

export function quickNoteRoutes(db: Db) {
  const router = Router();
  const svc = quickNoteService(db);
  const heartbeat = heartbeatService(db);

  async function wakeJarvisIfActive(companyId: string, noteId: string): Promise<void> {
    const jarvisAgents = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.name, "Jarvis"),
          not(inArray(agents.status, ["terminated", "pending_approval"])),
        ),
      )
      .limit(1);
    if (!jarvisAgents[0]) return;
    await heartbeat.wakeup(jarvisAgents[0].id, {
      source: "automation",
      triggerDetail: "system",
      reason: "quick_note_created",
      payload: { noteId },
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: { noteId, source: "quick_note.created" },
    });
  }

  // List notes for current user
  router.get("/companies/:companyId/quick-notes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const userId = (req.actor as { userId: string }).userId;
    const includeDismissed = req.query.includeDismissed === "true";
    const notes = await svc.list(companyId, userId, { includeDismissed });
    res.json(notes);
  });

  // Create note
  router.post("/companies/:companyId/quick-notes", validate(createSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const userId = (req.actor as { userId: string }).userId;
    const note = await svc.create({
      companyId,
      userId,
      text: req.body.text,
      metadata: req.body.metadata,
    });
    res.status(201).json(note);
    void wakeJarvisIfActive(companyId, note.id).catch(() => {});
  });

  // Get single note
  router.get("/quick-notes/:noteId", async (req, res) => {
    assertBoard(req);
    const note = await svc.getById(req.params.noteId as string);
    if (!note) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, note.companyId);
    res.json(note);
  });

  // Update note
  router.patch("/quick-notes/:noteId", validate(updateSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getById(req.params.noteId as string);
    if (!existing) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, existing.companyId);
    const note = await svc.update(req.params.noteId as string, existing.companyId, req.body);
    res.json(note);
  });

  // Delete note
  router.delete("/quick-notes/:noteId", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getById(req.params.noteId as string);
    if (!existing) return res.status(404).json({ error: "Not found" });
    assertCompanyAccess(req, existing.companyId);
    await svc.remove(req.params.noteId as string, existing.companyId);
    res.status(204).end();
  });

  // List thread entries for a note
  router.get("/quick-notes/:noteId/threads", async (req, res) => {
    assertBoard(req);
    const entries = await svc.listThreads(req.params.noteId as string);
    res.json(entries);
  });

  // Add thread entry (user reply)
  router.post("/quick-notes/:noteId/threads", validate(threadSchema), async (req, res) => {
    assertBoard(req);
    const userId = (req.actor as { userId: string }).userId;
    const noteId = req.params.noteId as string;
    const entry = await svc.addThread({
      noteId,
      authorType: "user",
      authorId: userId,
      body: req.body.body,
    });
    res.status(201).json(entry);
    const note = await svc.getById(noteId);
    if (note) {
      void wakeJarvisIfActive(note.companyId, noteId).catch(() => {});
    }
  });

  return router;
}
