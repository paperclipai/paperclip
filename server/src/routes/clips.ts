import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  buildAgentClipSnapshot,
  buildBundleClipSnapshot,
  buildRoutineClipSnapshot,
  buildSkillClipSnapshot,
  buildTeamClipSnapshot,
  clipImportApplySchema,
  clipImportPreviewSchema,
  clipManifestSchema,
  clipSharePreviewSchema,
  createClipCommentSchema,
  createClipCreatorProfileSchema,
  createClipImportTelemetrySchema,
  createClipReportSchema,
  createClipRevisionSchema,
  createClipShowcaseSchema,
  createClipVoteSchema,
  publishClipSchema,
  updateClipSchema,
  isUuidLike,
  type CompanyPortabilityFileEntry,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { badRequest, forbidden, unprocessable } from "../errors.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo } from "./authz.js";
import { clipService } from "../services/clips.js";
import { companyPortabilityService, companyService, logActivity } from "../services/index.js";
import type { StorageService } from "../storage/types.js";

const CLIP_RATE_LIMIT_WINDOW_MS = 60_000;
const CLIP_RATE_LIMIT_MAX_REQUESTS = 60;
const clipRateLimitHits = new Map<string, number[]>();

function actorForClip(req: Request) {
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      userId: null,
    };
  }
  if (req.actor.type === "board") {
    return {
      actorType: "user" as const,
      actorId: req.actor.userId ?? "board",
      agentId: null,
      userId: req.actor.userId ?? null,
    };
  }
  return {
    actorType: "anonymous" as const,
    actorId: "anonymous",
    agentId: null,
    userId: null,
  };
}

function requireAuthenticatedClipActor(req: Request) {
  assertAuthenticated(req);
  const actor = actorForClip(req);
  if (actor.actorType === "anonymous") throw forbidden("Authenticated actor required");
  return actor;
}

function getClipCompanyIdParam(req: Request) {
  const companyId = req.params.companyId as string;
  if (!isUuidLike(companyId)) {
    throw badRequest("Invalid companyId path parameter.");
  }
  return companyId;
}

function consumeClipRateLimit(req: Request, res: { setHeader(name: string, value: string): void; status(code: number): { json(value: unknown): void } }, action: string) {
  const now = Date.now();
  const cutoff = now - CLIP_RATE_LIMIT_WINDOW_MS;
  const actor = actorForClip(req);
  const ip = req.ip || req.socket.remoteAddress || "unknown-ip";
  const key = `${action}:${actor.actorType}:${actor.actorId}:${ip}`;
  const recent = (clipRateLimitHits.get(key) ?? []).filter((hit) => hit > cutoff);
  if (recent.length >= CLIP_RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil(((recent[0] ?? now) + CLIP_RATE_LIMIT_WINDOW_MS - now) / 1000));
    clipRateLimitHits.set(key, recent);
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({ error: "Clip rate limit exceeded", retryAfterSeconds });
    return false;
  }
  recent.push(now);
  clipRateLimitHits.set(key, recent);
  return true;
}

export function clipRoutes(db: Db, storage?: StorageService) {
  const router = Router();
  const svc = clipService(db);
  const portability = companyPortabilityService(db, storage);
  const companies = companyService(db);

  function slugify(value: string, fallback: string) {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 96);
    return slug.length >= 3 ? slug : fallback;
  }

  function clipSlugFromUrl(value: string) {
    const trimmed = value.trim();
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) return trimmed;
    try {
      const url = new URL(trimmed);
      const parts = url.pathname.split("/").filter(Boolean);
      const index = parts.findIndex((part) => part === "clips");
      const slug = index >= 0 ? parts[index + 1] : parts.at(-1);
      if (slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return slug;
    } catch {
      // Fall through to the validation error below.
    }
    throw unprocessable("Enter a clip URL or slug.");
  }

  function dependencyInputsFromManifest(manifest: ReturnType<typeof clipManifestSchema.parse>) {
    return [
      ...manifest.dependencies.adapters.map((entry) => ({
        type: "adapter" as const,
        key: entry.type,
        displayName: entry.type,
        required: entry.required ? "required" as const : "optional" as const,
        metadata: { sourceRefs: entry.sourceRefs, note: entry.note },
      })),
      ...manifest.dependencies.plugins.map((entry) => ({
        type: "plugin" as const,
        key: entry.key,
        displayName: entry.key,
        required: entry.requirement,
        metadata: { sourceRefs: entry.sourceRefs, note: entry.note },
      })),
      ...manifest.dependencies.skills.map((entry) => ({
        type: "skill" as const,
        key: entry.key,
        displayName: entry.slug,
        required: entry.requirement,
        metadata: { sourceRefs: entry.sourceRefs },
      })),
      ...manifest.dependencies.secrets.map((entry) => ({
        type: "secret" as const,
        key: entry.key,
        displayName: entry.key,
        required: entry.requirement,
        metadata: { sourceRefs: entry.sourceRefs, description: entry.description },
      })),
      ...manifest.dependencies.permissions.map((entry) => ({
        type: "permission" as const,
        key: entry.capability,
        displayName: entry.capability,
        required: "required" as const,
        metadata: { sourceRefs: entry.sourceRefs, reason: entry.reason },
      })),
      ...manifest.dependencies.workspaces.map((entry) => ({
        type: "workspace" as const,
        key: entry.key,
        displayName: entry.key,
        required: entry.repoUrlRequired ? "required" as const : "optional" as const,
        metadata: { sourceRefs: entry.sourceRefs, pinnedRefRecommended: entry.pinnedRefRecommended },
      })),
    ];
  }

  function clipFilesFromPayload(payload: Record<string, unknown>) {
    const artifact = payload.artifact;
    const artifactPayload =
      artifact && typeof artifact === "object"
        ? (artifact as Record<string, unknown>).payload
        : null;
    if (!artifactPayload || typeof artifactPayload !== "object") return null;
    const files = (artifactPayload as Record<string, unknown>).files;
    if (!files || typeof files !== "object" || Array.isArray(files)) return null;
    return files as Record<string, CompanyPortabilityFileEntry>;
  }

  async function buildClipImportPreview(companyId: string, input: { url: string; collisionStrategy?: "rename" | "skip" }) {
    const slug = clipSlugFromUrl(input.url);
    const clip = await svc.getPublicDetail(slug);
    if (!clip?.currentRevision) {
      throw unprocessable("Clip was not found or is not importable.");
    }
    const manifestPayload = clip.currentRevision.manifestPayload;
    const parsed = clipManifestSchema.safeParse(manifestPayload);
    if (!parsed.success) {
      throw unprocessable("Clip revision does not contain a valid clip manifest.");
    }
    const files = clipFilesFromPayload(manifestPayload);
    if (!files) {
      throw unprocessable("Clip revision does not include portable files. Publish it again from the app before importing.");
    }
    const preview = await portability.previewImport({
      source: { type: "inline", rootPath: parsed.data.clip.slug, files },
      include: { company: false, agents: true, projects: true, issues: true, skills: true },
      target: { mode: "existing_company", companyId },
      collisionStrategy: input.collisionStrategy ?? "rename",
    }, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    return {
      clip,
      parsedManifest: parsed.data,
      files,
      preview,
      source: {
        url: input.url,
        revisionNumber: clip.currentRevision.revisionNumber,
        manifestChecksum: clip.currentRevision.manifestChecksum,
        artifactChecksum: clip.currentRevision.artifactChecksum,
      },
      safety: {
        dangerousCapabilities: parsed.data.security.dangerousCapabilities,
        requiredSecrets: parsed.data.dependencies.secrets.map((entry) => entry.key),
        permissions: parsed.data.dependencies.permissions.map((entry) => entry.capability),
        routineTriggersEnabledByDefault: parsed.data.security.routinePolicy.importedTriggersEnabledByDefault,
        webhookSecretsRegenerated: parsed.data.security.routinePolicy.webhookSecretsRegenerated,
      },
    };
  }

  router.get("/public/clips", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : null;
    const type = typeof req.query.type === "string" ? req.query.type : null;
    const tag = typeof req.query.tag === "string" ? req.query.tag : null;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const offset = typeof req.query.offset === "string" ? Number(req.query.offset) : undefined;
    res.json(await svc.listPublic({ q, type, tag, limit, offset }));
  });

  router.get("/public/clips/:slug", async (req, res) => {
    const detail = await svc.getPublicDetail(req.params.slug as string);
    if (!detail) {
      res.status(404).json({ error: "Clip not found" });
      return;
    }
    res.json(detail);
  });

  router.get("/public/clips/:slug/revisions/:revisionNumber", async (req, res) => {
    const revisionNumber = Number(req.params.revisionNumber);
    const detail = Number.isInteger(revisionNumber) && revisionNumber > 0
      ? await svc.getPublicRevision(req.params.slug as string, revisionNumber)
      : null;
    if (!detail) {
      res.status(404).json({ error: "Clip revision not found" });
      return;
    }
    res.json(detail);
  });

  router.get("/public/clips/:slug/manifest", async (req, res) => {
    const detail = await svc.getPublicDetail(req.params.slug as string);
    if (!detail?.currentRevision) {
      res.status(404).json({ error: "Clip manifest not found" });
      return;
    }
    res.json(detail.currentRevision.manifestPayload);
  });

  router.get("/public/clips/:slug/revisions/:revisionNumber/manifest", async (req, res) => {
    const revisionNumber = Number(req.params.revisionNumber);
    const detail = Number.isInteger(revisionNumber) && revisionNumber > 0
      ? await svc.getPublicRevision(req.params.slug as string, revisionNumber)
      : null;
    if (!detail?.currentRevision) {
      res.status(404).json({ error: "Clip manifest not found" });
      return;
    }
    res.json(detail.currentRevision.manifestPayload);
  });

  router.get("/public/creators/:handle", async (req, res) => {
    const profile = await svc.getCreatorPublicProfile(req.params.handle as string);
    if (!profile) {
      res.status(404).json({ error: "Creator profile not found" });
      return;
    }
    res.json(profile);
  });

  router.post("/companies/:companyId/clips/profiles", validate(createClipCreatorProfileSchema), async (req, res) => {
    const companyId = getClipCompanyIdParam(req);
    assertCompanyAccess(req, companyId);
    const profile = await svc.createCreatorProfile(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "clip.profile_created",
      entityType: "clip_creator_profile",
      entityId: profile.id,
      details: { handle: profile.handle },
    });
    res.status(201).json(profile);
  });

  router.post("/companies/:companyId/clips/share-preview", validate(clipSharePreviewSchema), async (req, res) => {
    const companyId = getClipCompanyIdParam(req);
    assertCompanyAccess(req, companyId);
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const body = req.body as {
      source: { type: "team" | "agent" | "skill" | "routine" | "bundle"; id: string };
      title?: string;
      summary?: string;
      slug?: string;
      visibility?: "private_share" | "unlisted" | "public";
      revisionNote?: string | null;
    };
    const include = { company: false, agents: false, projects: false, issues: false, skills: false };
    const exportRequest: {
      include: typeof include;
      agents?: string[];
      skills?: string[];
      issues?: string[];
      expandReferencedSkills?: boolean;
    } = { include };

    if (body.source.type === "agent") {
      exportRequest.include.agents = true;
      exportRequest.include.skills = true;
      exportRequest.agents = [body.source.id];
    } else if (body.source.type === "team") {
      exportRequest.include.agents = true;
      exportRequest.include.skills = true;
      exportRequest.agents = body.source.id === "company" ? undefined : [body.source.id];
    } else if (body.source.type === "skill") {
      exportRequest.include.skills = true;
      exportRequest.skills = [body.source.id];
    } else if (body.source.type === "routine") {
      exportRequest.include.agents = true;
      exportRequest.include.projects = true;
      exportRequest.include.issues = true;
      exportRequest.include.skills = true;
      exportRequest.issues = [body.source.id];
    } else {
      exportRequest.include.agents = true;
      exportRequest.include.projects = true;
      exportRequest.include.issues = true;
      exportRequest.include.skills = true;
    }
    exportRequest.expandReferencedSkills = true;

    const exportPreview = await portability.previewExport(companyId, exportRequest);
    const sourceLabel =
      exportPreview.manifest.agents[0]?.name
      ?? exportPreview.manifest.skills[0]?.name
      ?? exportPreview.manifest.issues[0]?.title
      ?? exportPreview.manifest.company?.name
      ?? company.name;
    const title = body.title ?? `${sourceLabel} ${body.source.type === "bundle" ? "bundle" : "clip"}`;
    const summary = body.summary ?? `Portable ${body.source.type} package shared from ${company.name}.`;
    const visibility = body.visibility ?? "unlisted";
    const slug = body.slug ?? slugify(title, `clip-${body.source.type}`);
    const creator = {
      profileId: null,
      handle: slugify(company.issuePrefix || company.name, "paperclip-company"),
      displayName: company.name,
    };
    const snapshotInput = {
      clip: {
        slug,
        revisionNumber: 1,
        title,
        summary,
        visibility,
        creator,
      },
      artifact: {
        manifest: exportPreview.manifest,
        files: exportPreview.files,
      },
      source: {
        exportedAt: new Date().toISOString(),
        paperclipCompatibility: null,
      },
    };
    const snapshot =
      body.source.type === "agent"
        ? buildAgentClipSnapshot(snapshotInput)
        : body.source.type === "team"
          ? buildTeamClipSnapshot(snapshotInput)
          : body.source.type === "skill"
            ? buildSkillClipSnapshot(snapshotInput)
            : body.source.type === "routine"
              ? buildRoutineClipSnapshot(snapshotInput)
              : buildBundleClipSnapshot(snapshotInput);
    const manifestPayload = {
      ...snapshot,
      artifact: {
        ...snapshot.artifact,
        payload: {
          ...snapshot.artifact.payload,
          files: exportPreview.files,
        },
      },
    };
    const parsedManifest = clipManifestSchema.parse(manifestPayload);
    const publishRequest = {
      creatorProfile: {
        handle: creator.handle,
        displayName: creator.displayName,
      },
      slug,
      type: body.source.type,
      title,
      summary,
      description: summary,
      visibility,
      tags: [body.source.type],
      categories: [],
      useCases: [],
      requiredProviders: parsedManifest.dependencies.adapters.map((entry) => entry.type),
      compatibility: parsedManifest.publication.compatibility,
      sourceKind: "paperclip_company_object",
      sourceObjectType: body.source.type,
      sourceObjectId: body.source.id,
      revision: {
        manifestVersion: parsedManifest.schema,
        manifestChecksum: parsedManifest.checksums.manifest,
        artifactChecksum: parsedManifest.checksums.artifact,
        manifestPayload,
        artifactRef: null,
        dependencyGraph: parsedManifest.dependencies,
        dependencies: dependencyInputsFromManifest(parsedManifest),
        permissions: parsedManifest.dependencies.permissions.map((entry) => ({
          capability: entry.capability,
          reason: entry.reason,
        })),
        secretsSchema: parsedManifest.dependencies.secrets.map((entry) => ({
          key: entry.key,
          description: entry.description,
          requirement: entry.requirement,
        })),
        budgetEstimate: {
          monthlyCents: parsedManifest.dependencies.budgetHints.monthlyCents,
        },
        redactionReport: parsedManifest.security.redactionReport,
        dangerousCapabilities: parsedManifest.security.dangerousCapabilities,
        securityReviewState: parsedManifest.security.reviewState,
        verificationState: parsedManifest.verification.validationStatus,
        compatibility: parsedManifest.publication.compatibility,
        changeSummary: body.revisionNote ?? null,
        breakingChanges: null,
        migrationNotes: null,
      },
    };

    res.json({
      source: {
        type: body.source.type,
        id: body.source.id,
        label: sourceLabel,
      },
      publishRequest,
      exportPreview,
      manifest: parsedManifest,
      dependencyCounts: {
        adapters: parsedManifest.dependencies.adapters.length,
        plugins: parsedManifest.dependencies.plugins.length,
        skills: parsedManifest.dependencies.skills.length,
        secrets: parsedManifest.dependencies.secrets.length,
        permissions: parsedManifest.dependencies.permissions.length,
        workspaces: parsedManifest.dependencies.workspaces.length,
      },
      redactionSummary: parsedManifest.security.redactionReport.summary,
      dangerousCapabilities: parsedManifest.security.dangerousCapabilities,
      warnings: exportPreview.warnings,
    });
  });

  router.post("/companies/:companyId/clips/publish", validate(publishClipSchema), async (req, res) => {
    const companyId = getClipCompanyIdParam(req);
    assertCompanyAccess(req, companyId);
    if (!consumeClipRateLimit(req, res, "publish")) return;
    const result = await svc.publish(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "clip.published",
      entityType: "clip",
      entityId: result.clip.id,
      details: {
        slug: result.clip.slug,
        revisionId: result.revision.id,
        revisionNumber: result.revision.revisionNumber,
        visibility: result.clip.visibility,
        status: result.clip.status,
      },
    });
    res.status(201).json(result);
  });

  router.post("/companies/:companyId/clips/import-preview", validate(clipImportPreviewSchema), async (req, res) => {
    const companyId = getClipCompanyIdParam(req);
    assertCompanyAccess(req, companyId);
    const result = await buildClipImportPreview(companyId, req.body);
    res.json({
      clip: result.clip,
      preview: result.preview,
      safety: result.safety,
      source: result.source,
    });
  });

  router.post("/companies/:companyId/clips/import", validate(clipImportApplySchema), async (req, res) => {
    const companyId = getClipCompanyIdParam(req);
    assertCompanyAccess(req, companyId);
    const result = await buildClipImportPreview(companyId, req.body);
    const importResult = await portability.importBundle({
      source: { type: "inline", rootPath: result.parsedManifest.clip.slug, files: result.files },
      include: { company: false, agents: true, projects: true, issues: true, skills: true },
      target: { mode: "existing_company", companyId },
      collisionStrategy: req.body.collisionStrategy ?? "rename",
    }, req.actor.type === "board" ? req.actor.userId : null, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    await svc.recordImportTelemetry(result.clip.slug, {
      revisionNumber: result.source.revisionNumber,
      destinationCompanyId: companyId,
      status: "applied",
      sourceUrl: result.source.url.startsWith("http") ? result.source.url : null,
      revisionUrl: result.clip.currentRevision
        ? `/clips/${result.clip.slug}/revisions/${result.clip.currentRevision.revisionNumber}`
        : null,
      metadata: {
        selectedOptions: req.body.selectedOptions ?? {},
        agentCount: importResult.agents.length,
        projectCount: importResult.projects.length,
        warningCount: importResult.warnings.length,
      },
    }, actorForClip(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "clip.imported",
      entityType: "clip",
      entityId: result.clip.id,
      details: {
        slug: result.clip.slug,
        revisionNumber: result.source.revisionNumber,
        agentCount: importResult.agents.length,
        projectCount: importResult.projects.length,
        warningCount: importResult.warnings.length,
      },
    });
    res.json({
      importResult,
      clip: result.clip,
      source: result.source,
    });
  });

  router.post("/clips/:clipId/revisions", validate(createClipRevisionSchema), async (req, res) => {
    const clip = await svc.getClipById(req.params.clipId as string);
    if (!clip) {
      res.status(404).json({ error: "Clip not found" });
      return;
    }
    assertCompanyAccess(req, clip.sourceCompanyId);
    if (!consumeClipRateLimit(req, res, "update")) return;
    const result = await svc.createRevision(clip.id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: clip.sourceCompanyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "clip.revision_published",
      entityType: "clip_revision",
      entityId: result.revision.id,
      details: {
        clipId: clip.id,
        slug: clip.slug,
        revisionNumber: result.revision.revisionNumber,
      },
    });
    res.status(201).json(result);
  });

  router.patch("/clips/:clipId", validate(updateClipSchema), async (req, res) => {
    const clip = await svc.getClipById(req.params.clipId as string);
    if (!clip) {
      res.status(404).json({ error: "Clip not found" });
      return;
    }
    assertCompanyAccess(req, clip.sourceCompanyId);
    const actorInfo = getActorInfo(req);
    const updated = await svc.updateClip(clip.id, req.body, {
      actorType: actorInfo.actorType,
      actorId: actorInfo.actorId,
      agentId: actorInfo.agentId,
      userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    });
    await logActivity(db, {
      companyId: clip.sourceCompanyId,
      actorType: actorInfo.actorType,
      actorId: actorInfo.actorId,
      agentId: actorInfo.agentId,
      runId: actorInfo.runId,
      action: req.body.status === "delisted" || req.body.moderationState === "delisted"
        ? "clip.delisted"
        : req.body.moderationState
          ? "clip.moderated"
          : "clip.updated",
      entityType: "clip",
      entityId: clip.id,
      details: {
        slug: clip.slug,
        status: updated.status,
        moderationState: updated.moderationState,
      },
    });
    res.json(updated);
  });

  router.post("/public/clips/:slug/votes", validate(createClipVoteSchema), async (req, res) => {
    const actor = requireAuthenticatedClipActor(req);
    if (!consumeClipRateLimit(req, res, "vote")) return;
    const result = await svc.createVote(req.params.slug as string, req.body, actor);
    await logActivity(db, {
      companyId: result.clip.sourceCompanyId,
      actorType: actor.actorType === "agent" ? "agent" : "user",
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "clip.vote_created",
      entityType: "clip",
      entityId: result.clip.id,
      details: {
        slug: result.clip.slug,
        revisionId: result.revision.id,
        revisionNumber: result.revision.revisionNumber,
        vote: req.body.vote,
      },
    });
    res.status(201).json({ ok: true, metrics: result.clip });
  });

  router.post("/public/clips/:slug/report", validate(createClipReportSchema), async (req, res) => {
    const actor = actorForClip(req);
    if (!consumeClipRateLimit(req, res, "report")) return;
    const clip = await svc.createReport(req.params.slug as string, req.body, actor);
    await logActivity(db, {
      companyId: clip.sourceCompanyId,
      actorType: actor.actorType === "agent" ? "agent" : actor.actorType === "user" ? "user" : "system",
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "clip.report_created",
      entityType: "clip",
      entityId: clip.id,
      details: { slug: clip.slug, reason: req.body.reason, moderationState: clip.moderationState },
    });
    res.status(201).json({ ok: true });
  });

  router.post("/public/clips/:slug/comments", validate(createClipCommentSchema), async (req, res) => {
    const actor = requireAuthenticatedClipActor(req);
    if (!consumeClipRateLimit(req, res, "comment")) return;
    const clip = await svc.createComment(req.params.slug as string, req.body, actor);
    await logActivity(db, {
      companyId: clip.sourceCompanyId,
      actorType: actor.actorType === "agent" ? "agent" : "user",
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "clip.comment_created",
      entityType: "clip",
      entityId: clip.id,
      details: { slug: clip.slug },
    });
    res.status(201).json({ ok: true });
  });

  router.post("/public/clips/:slug/showcase", validate(createClipShowcaseSchema), async (req, res) => {
    const actor = requireAuthenticatedClipActor(req);
    if (!consumeClipRateLimit(req, res, "showcase")) return;
    const clip = await svc.createShowcase(req.params.slug as string, req.body, actor);
    await logActivity(db, {
      companyId: clip.sourceCompanyId,
      actorType: actor.actorType === "agent" ? "agent" : "user",
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "clip.showcase_created",
      entityType: "clip",
      entityId: clip.id,
      details: { slug: clip.slug, validationState: req.body.validationState },
    });
    res.status(201).json({ ok: true });
  });

  router.post("/public/clips/:slug/import-telemetry", validate(createClipImportTelemetrySchema), async (req, res) => {
    if (req.body.destinationCompanyId) {
      assertCompanyAccess(req, req.body.destinationCompanyId);
    }
    if (!consumeClipRateLimit(req, res, "import")) return;
    const actor = actorForClip(req);
    const clip = await svc.recordImportTelemetry(req.params.slug as string, req.body, actor);
    await logActivity(db, {
      companyId: req.body.destinationCompanyId ?? clip.sourceCompanyId,
      actorType: actor.actorType === "agent" ? "agent" : actor.actorType === "user" ? "user" : "system",
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "clip.import_telemetry_created",
      entityType: "clip",
      entityId: clip.id,
      details: { slug: clip.slug, status: req.body.status ?? "previewed" },
    });
    res.status(201).json({ ok: true });
  });

  return router;
}
