import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, type EgmGateConfig, type IssueSnapshot } from "./contracts.js";
import { buildGateComment, evaluateIssue, parseRepoSlug } from "./evidence.js";
import { JOB_KEY_SWEEP, TOOL_KEY_LEVEL } from "./manifest.js";

const PLUGIN_NAME = "egm-gate";
/** Ventana del barrido: solo issues cerradas hace poco (el cierre viejo ya no se toca). */
const SWEEP_WINDOW_MS = 1000 * 60 * 60 * 3;
/** Paginacion del barrido: se avanza hasta salir de la ventana, no solo la 1ª pagina. */
const SWEEP_PAGE = 100;
/** Techo de issues por compania en un barrido (6 paginas de 100). */
const SWEEP_MAX_ISSUES = 600;
/** Techo de companias recorridas por barrido. */
const SWEEP_MAX_COMPANIES = 200;
const MAX_COMMENTS_PER_ISSUE = 3;
/** El registro por issue vive en su propia clave de state: dos issues no se pisan. */
const stateKeyFor = (issueId: string) => `gate:issue:${issueId}`;

type GateRecord = { at: string; count: number };

/** Un chequeo por issue a la vez: dos eventos simultáneos no se pisan. */
const inFlight = new Map<string, Promise<void>>();

async function readConfig(ctx: PluginContext, companyId?: string): Promise<EgmGateConfig> {
  const raw = (await ctx.config.get(companyId).catch(() => ({}))) as Record<string, unknown>;
  const lines = typeof raw.fullDiffLines === "number" ? raw.fullDiffLines : DEFAULT_CONFIG.fullDiffLines;
  const files = typeof raw.fullDiffFiles === "number" ? raw.fullDiffFiles : DEFAULT_CONFIG.fullDiffFiles;
  return { ...DEFAULT_CONFIG, fullDiffLines: lines, fullDiffFiles: files };
}

/** Repo `owner/name` del workspace principal del proyecto (si lo hay). */
async function projectRepo(ctx: PluginContext, projectId: string | null, companyId: string): Promise<string | null> {
  if (!projectId) return null;
  try {
    const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
    const primary = workspaces.find((w) => w.isPrimary) ?? workspaces[0];
    return parseRepoSlug(primary?.repoUrl ?? null);
  } catch {
    return null;
  }
}

type SnapshotResult =
  | { ok: true; snapshot: IssueSnapshot }
  | { ok: false; reason: string };

/**
 * Arma la foto de una issue con todo lo que el gate puede verificar.
 *
 * Una lectura fallida NO es lo mismo que "no hay evidencia": si falla, el gate
 * no toca el estado de la issue (no puede afirmar que no hay entrega porque no
 * pudo leer).
 */
async function snapshotIssue(ctx: PluginContext, issueId: string, companyId: string): Promise<SnapshotResult> {
  let issue;
  try {
    issue = await ctx.issues.get(issueId, companyId);
  } catch (error) {
    return { ok: false, reason: `no se pudo leer la issue: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!issue) return { ok: false, reason: "la issue no existe" };

  // Una lectura puede fallar por unReasons transitorio (timeout, DB ocupada). Se
  // reintenta: si tras los intentos sigue fallando, el gate NO toca el estado
  // (no puede afirmar que no hay entrega), pero deja el motivo anotado.
  let reads: PromiseSettledResult<unknown>[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    reads = await Promise.allSettled([
      ctx.issues.listComments(issueId, companyId),
      ctx.issues.listAttachments(issueId, companyId),
      ctx.issues.documents.get(issueId, "plan", companyId),
      projectRepo(ctx, issue.projectId ?? null, companyId),
    ]);
    if (!reads.some((r) => r.status === "rejected")) break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
  }
  const failed = reads.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    return {
      ok: false,
      reason: `lectura fallida tras 3 intentos (${failed.length}): no se puede afirmar que no hay evidencia`,
    };
  }
  const [comments, attachments, plan, expectedRepo] = reads.map((r) => (r as PromiseFulfilledResult<unknown>).value) as [
    Awaited<ReturnType<typeof ctx.issues.listComments>>,
    Awaited<ReturnType<typeof ctx.issues.listAttachments>>,
    Awaited<ReturnType<typeof ctx.issues.documents.get>>,
    string | null,
  ];
  return {
    ok: true,
    snapshot: {
      issueId: issue.id,
      companyId,
      identifier: issue.identifier ?? issue.id,
      title: issue.title,
      description: issue.description ?? null,
      status: issue.status,
      priority: issue.priority,
      comments: comments.map((c) => ({ id: c.id, body: c.body, createdAt: String(c.createdAt ?? "") })),
      attachments: attachments.map((a) => ({
        id: a.id,
        fileName: a.originalFilename ?? null,
        contentType: a.contentType ?? null,
      })),
      planBody: plan?.body ?? null,
      expectedRepo,
    },
  };
}

async function readRecord(ctx: PluginContext, companyId: string, issueId: string): Promise<GateRecord | null> {
  const raw = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: stateKeyFor(issueId) });
  return (raw as GateRecord | null) ?? null;
}

async function writeRecord(ctx: PluginContext, companyId: string, issueId: string, record: GateRecord): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: stateKeyFor(issueId) },
    record,
  );
}

/**
 * Gate de cierre: si una issue quedó en `done` sin evidencia de entrega, vuelve
 * a `in_review` con un comentario que dice exactamente qué falta.
 *
 * No pide una card, no pide decisión y no pide un documento: pide el cambio.
 */
async function enforceGate(ctx: PluginContext, issueId: string, companyId: string): Promise<void> {
  const config = await readConfig(ctx, companyId);
  const first = await snapshotIssue(ctx, issueId, companyId);
  if (!first.ok) {
    ctx.logger.warn("gate: no se pudo leer la issue, no se toca su estado", { issueId, reason: first.reason });
    return;
  }
  let snapshot = first.snapshot;
  if (snapshot.status !== "done") return;

  let evaluation = evaluateIssue(snapshot, config);

  // Gracia: el cierre y la revisión del `plan` pueden llegar con milisegundos de
  // diferencia. Antes de rebotar, se relee el documento una vez más.
  if (!evaluation.ok) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const again = await snapshotIssue(ctx, issueId, companyId);
    if (!again.ok) {
      ctx.logger.warn("gate: relectura fallida, no se toca el estado", { issueId, reason: again.reason });
      return;
    }
    // Si mientras tanto la issue cambio de estado (la.cancelaron, la reiniciaron),
    // NO se toca: se respeta el estado mas reciente.
    if (again.snapshot.status !== "done") {
      ctx.logger.info("gate: la issue cambio de estado durante la espera", {
        issueId,
        status: again.snapshot.status,
      });
      return;
    }
    snapshot = again.snapshot;
    evaluation = evaluateIssue(snapshot, config);
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

  const previous = await readRecord(ctx, companyId, issueId);
  const count = (previous?.count ?? 0) + 1;

  if (count <= MAX_COMMENTS_PER_ISSUE) {
    await ctx.issues.createComment(issueId, buildGateComment(evaluation, snapshot.identifier), companyId);
  }

  // Volver a `in_review` puede ser rechazado por el guard de disposicion (una
  // issue sin camino de revision tipado). Si pasa, la issue se queda en `done`
  // sin evidencia: exactamente lo que el gate tiene que impedir. Se cae a
  // `todo`, que siempre es una transicion valida.
  const target = config.reopenAsInReview ? "in_review" : "todo";
  let reopenedAs = target;
  let moved = true;
  try {
    await ctx.issues.update(issueId, { status: target }, companyId);
  } catch (error) {
    reopenedAs = "todo";
    try {
      await ctx.issues.update(issueId, { status: "todo" }, companyId);
    } catch (fallbackError) {
      moved = false;
      ctx.logger.error("gate: no se pudo devolver la issue a revision ni a todo", {
        issueId,
        identifier: snapshot.identifier,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
    }
    ctx.logger.warn("gate: no se pudo volver a in_review, se deja en todo", {
      issueId,
      identifier: snapshot.identifier,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await writeRecord(ctx, companyId, issueId, { at: new Date().toISOString(), count });
  await ctx.activity.log({
    companyId,
    message: moved
      ? `gate EGM: ${snapshot.identifier} volvió a revisión (sin evidencia de entrega)`
      : `gate EGM: ${snapshot.identifier} NO se pudo devolver a revisión (sin evidencia de entrega)`,
    entityType: "issue",
    entityId: issueId,
    metadata: {
      identifier: snapshot.identifier,
      count,
      missing: evaluation.missing,
      reopenedAs: moved ? reopenedAs : null,
      moved,
    },
  });
  ctx.logger.warn("gate: cierre sin evidencia", {
    issueId,
    identifier: snapshot.identifier,
    count,
  });
}

/** Un chequeo por issue: los eventos simultáneos no se pisan. */
async function runGate(ctx: PluginContext, issueId: string, companyId: string): Promise<void> {
  const previous = inFlight.get(issueId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => enforceGate(ctx, issueId, companyId));
  inFlight.set(issueId, next);
  try {
    await next;
  } finally {
    if (inFlight.get(issueId) === next) inFlight.delete(issueId);
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME}: setup`);

    // 1. Gate de cierre, en vivo. `issue.created` tambien: una issue creada ya
    //    cerrada tiene que pasar por el gate tambien.
    const onIssueChange = async (event: PluginEvent) => {
      const issueId = event.entityId;
      const companyId = event.companyId;
      if (!issueId || !companyId) return;
      try {
        await runGate(ctx, issueId, companyId);
      } catch (error) {
        ctx.logger.error("gate: fallo al evaluar el cierre", {
          issueId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    ctx.events.on("issue.updated", onIssueChange);
    ctx.events.on("issue.created", onIssueChange);

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
        const companyId = String((params as { companyId?: unknown }).companyId ?? runCtx?.companyId ?? "");
        if (!issueId || !companyId) return { error: "issueId es obligatorio" };
        const result = await snapshotIssue(ctx, issueId, companyId);
        if (!result.ok) return { error: result.reason };
        const evaluation = evaluateIssue(result.snapshot, await readConfig(ctx, companyId));
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

    // 3. Barrido periodico: cubre las cierres que el evento no pudo revisar
    //    (por ejemplo, si una lectura fallo en el momento del cierre).
    ctx.jobs.register(JOB_KEY_SWEEP, async () => {
      try {
        // El job no viene con company: el barrido recorre las companias visibles.
        // Se PAGINA companies e issues. El host ordena las issues por prioridad y
        // despues por recencia, asi que leer solo la primera pagina dejaria fuera
        // un cierre nuevo de baja prioridad detras de 100 cierres viejos de alta.
        const cutoff = Date.now() - SWEEP_WINDOW_MS;
        let checked = 0;
        for (let companyOffset = 0; companyOffset < SWEEP_MAX_COMPANIES; companyOffset += SWEEP_PAGE) {
          const companies = await ctx.companies.list({ limit: SWEEP_PAGE, offset: companyOffset });
          if (companies.length === 0) break;
          for (const company of companies) {
            const companyId = String(company.id);
            // Dentro de la compania se avanza hasta salir de la ventana de tiempo.
            for (let offset = 0; offset < SWEEP_MAX_ISSUES; offset += SWEEP_PAGE) {
              const list = await ctx.issues.list({ companyId, status: "done", limit: SWEEP_PAGE, offset });
              if (list.length === 0) break;
              let sawRecent = false;
              for (const issue of list) {
                const updatedAt = Date.parse(String((issue as { updatedAt?: unknown }).updatedAt ?? ""));
                if (!Number.isFinite(updatedAt) || updatedAt < cutoff) continue;
                sawRecent = true;
                checked++;
                await runGate(ctx, issue.id, companyId);
              }
              // Toda la pagina es vieja: mas alla no hay nada que revisar.
              if (!sawRecent || list.length < SWEEP_PAGE) break;
            }
          }
          if (companies.length < SWEEP_PAGE) break;
        }
        ctx.logger.info("gate: barrido de cierres", { checked, windowHours: SWEEP_WINDOW_MS / 3600000 });
      } catch (error) {
        ctx.logger.error("gate: fallo el barrido de cierres", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // 4. Datos para la UI: estado del gate por issue.
    ctx.data.register("gate-status", async (params) => {
      const issueId = String(params.issueId ?? "");
      const companyId = String(params.companyId ?? "");
      if (!issueId) throw new Error("issueId es obligatorio");
      const result = await snapshotIssue(ctx, issueId, companyId);
      if (!result.ok) return { found: false, reason: result.reason };
      const evaluation = evaluateIssue(result.snapshot, await readConfig(ctx, companyId));
      return {
        found: true,
        identifier: result.snapshot.identifier,
        status: result.snapshot.status,
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
