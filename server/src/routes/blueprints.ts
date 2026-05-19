import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  buildBlueprintApprovalEvidence,
  summarizeMissing,
  validateBlueprintInstantiateInput,
  type BlueprintApprovalEvidence,
  type BlueprintInstantiateContext,
  type BlueprintInstantiateInput,
  type BlueprintInstantiatePreview,
  type BlueprintResolvedSecretBinding,
  type BlueprintSecretRefBinding,
  type BlueprintVersion,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  agentService,
  approvalService,
  blueprintCatalogService,
  companySkillService,
  logActivity,
  secretService,
  type BlueprintCatalogService,
} from "../services/index.js";
import { redactEventPayload } from "../redaction.js";

export const blueprintInstantiateSchema = z.object({
  config: z.record(z.unknown()).default({}),
  secretBindings: z
    .array(
      z.object({
        inputName: z.string().min(1),
        secretRef: z.string().min(1),
        configPath: z.string().optional(),
      }),
    )
    .default([]),
  notes: z.string().max(2000).optional().nullable(),
});

export type BlueprintInstantiateBody = z.infer<typeof blueprintInstantiateSchema>;

export type BlueprintRouterOptions = {
  catalog?: BlueprintCatalogService;
};

function publicVersion(version: BlueprintVersion) {
  return {
    ref: version.ref,
    key: version.key,
    version: version.version,
    title: version.title,
    category: version.category,
    description: version.description,
    status: version.status,
    requiredSkillRefs: [...version.requiredSkillRefs],
    mcpBundleRefs: [...version.mcpBundleRefs],
    requiredSecretInputs: [...version.requiredSecretInputs],
    requiredProviderKeys: [...version.requiredProviderKeys],
    permissionPolicies: version.permissionPolicies,
    runtimeDefaults: version.runtimeDefaults,
    budget: version.budget,
    validationContract: [...version.validationContract],
  };
}

function publicVersionDetail(version: BlueprintVersion) {
  return {
    ...publicVersion(version),
    systemPromptTemplate: version.systemPromptTemplate,
    configSchema: version.configSchema,
    source: version.source,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractBlueprintKey(metadata: unknown): string | null {
  const record = asRecord(metadata);
  if (!record) return null;
  const agentOs = asRecord(record.agentOs);
  if (!agentOs) return null;
  const key = agentOs.blueprintKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}

async function gatherInstantiateContext(
  db: Db,
  companyId: string,
  catalog: BlueprintCatalogService,
  version: BlueprintVersion,
  bindings: BlueprintSecretRefBinding[],
): Promise<{
  context: BlueprintInstantiateContext;
  resolvedBindings: BlueprintResolvedSecretBinding[];
}> {
  const [secrets, agentRows, skillRows] = await Promise.all([
    secretService(db).list(companyId),
    agentService(db).list(companyId).catch(() => [] as Array<{ metadata?: unknown }>),
    companySkillService(db)
      .list(companyId)
      .catch(() => [] as Array<{ key: string }>),
  ]);

  const secretByName = new Map(secrets.map((secret) => [secret.name, secret]));
  const secretByKey = new Map(secrets.map((secret) => [secret.key, secret]));

  const resolvedBindings: BlueprintResolvedSecretBinding[] = [];
  for (const binding of bindings) {
    const ref = binding.secretRef.trim();
    const match = secretByName.get(ref) ?? secretByKey.get(ref);
    if (match) {
      resolvedBindings.push({
        inputName: binding.inputName,
        secretId: match.id,
        ...(binding.configPath ? { configPath: binding.configPath } : {}),
      });
    }
  }

  const availableSecretInputNames = resolvedBindings.map((binding) => binding.inputName);

  const existingAgentKeys = agentRows
    .map((row) => extractBlueprintKey((row as { metadata?: unknown }).metadata))
    .filter((key): key is string => Boolean(key));

  const availableSkillKeys = skillRows
    .map((row) => (row as { key?: string }).key)
    .filter((key): key is string => typeof key === "string" && key.length > 0);

  // MCP bundle inventory is not yet tracked in a first-class service.
  // Treat the blueprint's declared bundle refs as available so validation does
  // not block on missing inventory; tighten when an MCP bundle registry exists.
  const availableMcpBundleKeys = [...version.mcpBundleRefs];

  const context: BlueprintInstantiateContext = {
    companyId,
    projectId: null,
    existingAgentKeys,
    availableSkillKeys,
    availableMcpBundleKeys,
    availableSecretInputNames,
    availableProviderKeys: catalog.getProviderKeys(),
  };
  return { context, resolvedBindings };
}

export function blueprintRoutes(db: Db, options: BlueprintRouterOptions = {}) {
  const router = Router();
  const catalog = options.catalog ?? blueprintCatalogService(db);
  const approvals = approvalService(db);

  router.get("/companies/:companyId/blueprints", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!catalog.isEnabled()) {
      res.json({ enabled: false, versions: [] });
      return;
    }
    res.json({
      enabled: true,
      versions: catalog.listVersions().map((version) => publicVersion(version)),
    });
  });

  router.get("/companies/:companyId/blueprints/:ref", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!catalog.isEnabled()) {
      throw notFound("Blueprint catalog is disabled");
    }
    const version = catalog.getByRef(req.params.ref as string);
    if (!version) {
      throw notFound("Blueprint version not found");
    }
    res.json(publicVersionDetail(version));
  });

  router.post(
    "/companies/:companyId/blueprints/:ref/instantiate",
    validate(blueprintInstantiateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (!catalog.isEnabled()) {
        throw notFound("Blueprint catalog is disabled");
      }
      const version = catalog.getByRef(req.params.ref as string);
      if (!version) {
        throw notFound("Blueprint version not found");
      }

      const body = req.body as BlueprintInstantiateBody;
      const input: BlueprintInstantiateInput = {
        config: body.config ?? {},
        secretBindings: body.secretBindings ?? [],
        notes: body.notes ?? null,
      };

      const { context, resolvedBindings } = await gatherInstantiateContext(
        db,
        companyId,
        catalog,
        version,
        input.secretBindings,
      );
      const validation = validateBlueprintInstantiateInput(version, input, context);
      const missing = summarizeMissing(version, input, context);

      const actor = getActorInfo(req);
      const evidence: BlueprintApprovalEvidence = buildBlueprintApprovalEvidence({
        version,
        input,
        resolvedSecretBindings: resolvedBindings,
        missing,
        generatedByAgentId: actor.actorType === "agent" ? actor.agentId : null,
        generatedByUserId: actor.actorType === "user" ? actor.actorId : null,
      });

      if (validation.kind === "invalid") {
        const blockedEvidence: BlueprintApprovalEvidence = {
          ...evidence,
          // Strip user-supplied config/bindings from 4xx previews to avoid
          // echoing potentially sensitive request material when input is rejected.
          config: {},
          secretBindings: [],
          notes: null,
        };
        const preview: BlueprintInstantiatePreview = {
          status: "blocked",
          blueprintRef: version.ref,
          blueprintKey: version.key,
          blueprintVersion: version.version,
          companyId,
          projectId: null,
          requiresApproval: true,
          submittable: false,
          missing,
          evidence: blockedEvidence,
          errors: validation.errors,
        };
        res.status(422).json(preview);
        return;
      }

      const approval = await approvals.create(companyId, {
        type: "request_board_approval",
        payload: {
          version: 1,
          surface: "agent_os_blueprint",
          action: "blueprint_instantiate",
          approvalScope: "blueprint_instantiate",
          approvalOnly: true,
          liveApply: false,
          liveExecution: false,
          liveExternalActions: false,
          blueprintRef: version.ref,
          evidence,
        },
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        requestedByAgentId: actor.actorType === "agent" ? actor.agentId : null,
        status: "pending",
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "blueprint.instantiate_requested",
        entityType: "approval",
        entityId: approval.id,
        details: {
          blueprintRef: version.ref,
          blueprintKey: version.key,
          blueprintVersion: version.version,
          requiredSecretInputs: [...version.requiredSecretInputs],
          requiredProviderKeys: [...version.requiredProviderKeys],
        },
      });

      const preview: BlueprintInstantiatePreview = {
        status: "ready",
        blueprintRef: version.ref,
        blueprintKey: version.key,
        blueprintVersion: version.version,
        companyId,
        projectId: null,
        requiresApproval: true,
        submittable: true,
        missing,
        evidence,
        errors: [],
      };

      const redactedApproval = {
        ...approval,
        payload: redactEventPayload(approval.payload as Record<string, unknown>) ?? {},
      };

      res.status(201).json({
        approval: redactedApproval,
        preview,
      });
    },
  );

  return router;
}
