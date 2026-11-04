import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, type EgmGateConfig, type IssueSnapshot } from "./contracts.js";
import { buildGateComment, evaluateIssue } from "./evidence.js";
import { JOB_KEY_RECONCILE, TOOL_KEY_LEVEL } from "./manifest.js";

const PLUGIN_NAME = "egm-gate";
const STATE_KEY = "gate:last-action";
const MAX_COMMENTS_PER_ISSUE = 3;

type GateRecord = { at: string; count: number };

async function readConfig(ctx: PluginContext, companyId?: string): Promise<EgmGateConfig> {
  const raw = (await ctx.config.get(companyId).catch(() => ({}))) as Record<string, unknown>;
  const lines = typeof raw.fullDiffLines === "number" ? raw.fullDiffLines : DEFAULT_CONFIG.fullDiffLines;
  const files = typeof raw.fullDiffFiles === "number" ? raw.fullDiffFiles : DEFAULT_CONFIG.fullDiffFiles;
  return { ...DEFAULT_CONFIG, fullDiffLines: lines, fullDiffFiles: files };
}

/** Arma la foto de una issue con todo lo que el gate puede verificar. */
async function snapshotIssue(ctx: PluginContext, issueId: string, companyId: string): Promise<IssueSnapshot | null> {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) return null;
  const [comments, attachments, plan] = await Promise.all([
    ctx.issues.listComments(issueId, companyId).catch(() => []),
    ctx.issues.listAttachments(issueId, companyId).catch(() => []),
    ctx.issues.documents.get(issueId, "plan", companyId).catch(() => null),
  ]);
  return {
    issueId: issue.id,
    companyId,
    identifier: issue.identifier ?? issue.id,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    comments: comments.map((c) => ({ id: c.id, body: c.body, createdAt: String(c.createdAt ?? "") })),
    attachments: attachments.map((a) => ({
      id: a.id,
      fileName: a.originalFilename ?? null,
      contentType: a.contentType ?? null,
    })),
    planBody: plan?.body ?? null,
  };
}

async function readRecords(ctx: PluginContext, companyId: string): Promise<Record<string, GateRecord>> {
  const raw = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEY });
  return (raw ?? {}) as Record<string, GateRecord>;
}

async function writeRecord(ctx: PluginContext, companyId: string, issueId: string, record: GateRecord): Promise<void> {
  const records = await readRecords(ctx, companyId);
  records[issueId] = record;
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEY }, records);
}

/**
 * Gate de cierre: si una issue quedó en `done` sin evidencia de entrega, vuelve
 * a `in_review` con un comentario que dice exactamente qué falta.
 *
 * No pide una card, no pide decisión y no pide un documento: pide el cambio.
 */
async function enforceGate(ctx: PluginContext, issueId: string, companyId: string): Promise<void> {
  const config = await readConfig(ctx, companyId);
  let snapshot = await snapshotIssue(ctx, issueId, companyId);
  if (!snapshot) return;
  if (snapshot.status !== "done") return;

  let evaluation = evaluateIssue(snapshot, config);

  // Gracia: el cierre y la revisión del `plan` pueden llegar con milisegundos de
  // diferencia. Antes de rebotar, se relee el documento una vez más.
  if (!evaluation.ok) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const again = await snapshotIssue(ctx, issueId, companyId);
    if (again && again.status === "done") {
      snapshot = again;
      evaluation = evaluateIssue(snapshot, config);
    }
  }

  if (evaluation.ok) {
    await ctx.activity.log({
      companyId,
      message: `gate EGM: ${snapshot.identifier} cerrada con evidencia (${evaluation.kind}, nivel ${evaluation.level})`,
      entityType: "issue",
      entityId: issueId,
      metadata: { identifier: snapshot.identifier, kind: evaluation.kind, level: evaluation.level },
    });
    return;
  }

  const records = await readRecords(ctx, companyId);
  const previous = records[issueId];
  const count = (previous?.count ?? 0) + 1;

  if (count <= MAX_COMMENTS_PER_ISSUE) {
    await ctx.issues.createComment(issueId, buildGateComment(evaluation, snapshot.identifier), companyId);
  }

  await ctx.issues.update(issueId, { status: config.reopenAsInReview ? "in_review" : "todo" }, companyId);
  await writeRecord(ctx, companyId, issueId, { at: new Date().toISOString(), count });
  await ctx.activity.log({
    companyId,
    message: `gate EGM: ${snapshot.identifier} volvió a revisión (sin evidencia de entrega)`,
    entityType: "issue",
    entityId: issueId,
    metadata: {
      identifier: snapshot.identifier,
      count,
      missing: evaluation.missing,
      reopenedAs: config.reopenAsInReview ? "in_review" : "todo",
    },
  });
  ctx.logger.warn("gate: cierre sin evidencia", {
    issueId,
    identifier: snapshot.identifier,
    count,
  });
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME}: setup`);

    // 1. Gate de cierre, en vivo.
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const issueId = event.entityId;
      const companyId = event.companyId;
      if (!issueId || !companyId) return;
      try {
        await enforceGate(ctx, issueId, companyId);
      } catch (error) {
        ctx.logger.error("gate: fallo al evaluar el cierre", {
          issueId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // 2. Herramienta nativa: "¿qué nivel de revisión necesita esta tarea?".
    ctx.tools.register(
      TOOL_KEY_LEVEL,
      {
        displayName: "Nivel de revisión EGM",
        description:
          "Devuelve el nivel de revisión que necesita la tarea según su entrega verificable (off | lite | full | human).",
        parametersSchema: {
          type: "object",
          properties: { issueId: { type: "string" } },
          required: ["issueId"],
        },
      },
      async (params, runCtx) => {
        const issueId = String((params as { issueId?: unknown }).issueId ?? "");
        const companyId = runCtx?.companyId ?? String((params as { companyId?: unknown }).companyId ?? "");
        if (!issueId || !companyId) return { error: "issueId es obligatorio" };
        const snapshot = await snapshotIssue(ctx, issueId, companyId);
        if (!snapshot) return { error: "issue no encontrada" };
        const evaluation = evaluateIssue(snapshot, await readConfig(ctx, companyId));
        return {
          content: `nivel=${evaluation.level} entrega=${evaluation.kind} evidencia=${evaluation.signals.length}`,
          data: {
            level: evaluation.level,
            kind: evaluation.kind,
            ok: evaluation.ok,
            signals: evaluation.signals,
            missing: evaluation.missing ?? null,
          },
        };
      },
    );

    // 3. Barrido horario de cierres sin evidencia (sustituye al gate en shell).
    ctx.jobs.register(JOB_KEY_RECONCILE, async (job) => {
      ctx.logger.info(`${PLUGIN_NAME}: barrido de cierres`, { jobKey: job.jobKey, runId: job.runId });
      // El barrido real lo hace el host vía rutina gestionada; el job queda
      // registrado como punto de extensión paraikos sweeps por proyecto.
    });

    // 4. Datos para la UI: estado del gate por issue.
    ctx.data.register("gate-status", async (params) => {
      const issueId = String(params.issueId ?? "");
      const companyId = String(params.companyId ?? "");
      if (!issueId) throw new Error("issueId es obligatorio");
      const snapshot = await snapshotIssue(ctx, issueId, companyId);
      if (!snapshot) return { found: false };
      const evaluation = evaluateIssue(snapshot, await readConfig(ctx, companyId));
      return {
        found: true,
        identifier: snapshot.identifier,
        status: snapshot.status,
        ok: evaluation.ok,
        level: evaluation.level,
        kind: evaluation.kind,
        signals: evaluation.signals,
        missing: evaluation.missing ?? null,
      };
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
