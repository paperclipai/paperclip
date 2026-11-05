import {
  DEFAULT_CONFIG,
  type EgmGateConfig,
  type EgmLevel,
  type EvidenceEvaluation,
  type EvidenceSignal,
  type IssueSnapshot,
} from "./contracts.js";

/**
 * Evidencia de entrega, en orden de fuerza:
 *   1. PR real del repo del proyecto (link a github.com/<owner>/<repo>/pull/<n>).
 *   2. Parche adjunto (attachment .patch/.diff).
 *   3. Medición verificada declarada en el documento `plan` (`EGM-VERIFIED:`).
 *   4. Decisión documentada (`EGM-DELIVERABLE: decision`) — para issues que no
 *      llevan código (una decisión del dueño, un veredicto, un análisis pedido).
 *   5. Firma humana (`EGM-APPROVED:`) — para tareas que tocan producción,
 *      dinero o datos: sin la firma de una persona, el cierre no se acepta.
 * Ninguna de las dos últimas requiere código: son entregables explícitos.
 */

const PR_PATTERN = /https?:\/\/(?:www\.)?github\.com\/([^\s)]+)\/pull\/(\d+)/gi;
const VERIFIED_PATTERN = /^\s*EGM-VERIFIED\s*:/im;
const DELIVERABLE_DECISION_PATTERN = /^\s*EGM-DELIVERABLE\s*:\s*decision\s*$/im;
const APPROVED_PATTERN = /^\s*EGM-APPROVED\s*:\s*(.+)$/im;
const DIFF_PATTERN = /^\s*EGM-DIFF\s*:\s*(\d+)\s+lines?\s+(\d+)\s+files?/im;

/**
 * Normaliza una URL de repo a `owner/name`.
 * Acepta https, ssh y git@, con o sin `.git`.
 */
export function parseRepoSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const text = String(url).trim();
  if (!text) return null;
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(text);
  if (ssh) return `${ssh[2]}/${ssh[3]}`;
  const https = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(text);
  if (https) return `${https[1]}/${https[2]}`;
  const bare = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(text);
  if (bare) return `${bare[1]}/${bare[2]}`;
  return null;
}

export type DeliveryFacts = {
  signals: EvidenceSignal[];
  /** Líneas de diff declaradas, si el plan las declara. */
  diffLines?: number;
  diffFiles?: number;
  /** El texto de la issue menciona un tema que exige aprobación humana. */
  touchesHumanTopic: boolean;
  /** PRs que se descartaron por ser de otro repo. */
  foreignPullRequests: string[];
  /** Firma humana declarada en el plan, si la hay. */
  humanApproval?: string;
};

export function collectDeliveryFacts(snapshot: IssueSnapshot): DeliveryFacts {
  const signals: EvidenceSignal[] = [];
  const foreignPullRequests: string[] = [];
  let diffLines: number | undefined;
  let diffFiles: number | undefined;
  const expected = snapshot.expectedRepo ? snapshot.expectedRepo.toLowerCase() : null;

  for (const comment of snapshot.comments) {
    // Todos los links del comentario, no solo el primero: un PR ajeno puede
    // aparecer antes que el válido.
    for (const match of comment.body.matchAll(PR_PATTERN)) {
      const repo = `${match[1]}/${match[2]}`.replace(/[^\w./-]/g, "").split("/").slice(0, 2).join("/");
      // Un PR de otro repo no es la entrega de esta issue.
      if (expected && repo.toLowerCase() !== expected) {
        foreignPullRequests.push(`${repo}/pull/${match[2]}`);
        continue;
      }
      signals.push({ kind: "pull_request", ref: `https://github.com/${repo}/pull/${match[2]}`, source: "comment" });
    }
  }

  for (const attachment of snapshot.attachments) {
    const name = (attachment.fileName ?? "").toLowerCase();
    if (name.endsWith(".patch") || name.endsWith(".diff")) {
      signals.push({ kind: "patch", ref: attachment.fileName ?? attachment.id, source: "attachment" });
    }
  }

  const plan = snapshot.planBody ?? "";
  if (VERIFIED_PATTERN.test(plan)) {
    signals.push({ kind: "measurement", ref: "plan:EGM-VERIFIED", source: "document" });
  }
  if (DELIVERABLE_DECISION_PATTERN.test(plan)) {
    signals.push({ kind: "decision", ref: "plan:EGM-DELIVERABLE", source: "document" });
  }
  const approved = APPROVED_PATTERN.exec(plan);
  if (approved) {
    signals.push({ kind: "human_approval", ref: approved[1].trim(), source: "document" });
  }
  const diff = DIFF_PATTERN.exec(plan);
  if (diff) {
    diffLines = Number(diff[1]);
    diffFiles = Number(diff[2]);
  }

  // El tema que exige a una persona se lee del TITULO, la DESCRIPCION y el plan:
  // una issue titulada "Actualizar el worker" cuya descripcion dice "desplegar
  // a produccion" necesita a una persona.
  const haystack = `${snapshot.title}\n${snapshot.description ?? ""}\n${plan}`.toLowerCase();
  const touchesHumanTopic = DEFAULT_CONFIG.humanTopics.some((topic) => haystack.includes(topic));

  return { signals, diffLines, diffFiles, touchesHumanTopic, foreignPullRequests, humanApproval: approved?.[1]?.trim() };
}

/**
 * ¿La issue está dentro de la frontera del agente que pregunta?
 *
 * El host sólo aplica el predicado de PRIVACIDAD a las lecturas de un plugin
 * (público/privado). Eso no es la frontera de un AGENTE: un agente de confianza
 * baja tiene su propio alcance (los issues de su proyecto y los que tiene
 * asignados) y no debe poder leer los metadatos de entrega de issues ajenas.
 *
 * Se acepta cuando la issue:
 *   - está asignada al agente que pregunta, o
 *   - pertenece al proyecto del run del agente.
 */
export function issueIsWithinAgentScope(
  snapshot: Pick<IssueSnapshot, "projectId" | "assigneeAgentId">,
  scope: { agentId?: string | null; projectId?: string | null },
): boolean {
  const agentId = scope.agentId?.trim();
  if (agentId && snapshot.assigneeAgentId === agentId) return true;
  const projectId = scope.projectId?.trim();
  if (projectId && snapshot.projectId && snapshot.projectId === projectId) return true;
  return false;
}

/**
 * Decide el nivel de revisión de una tarea. Éste es el corazón de "EGM sólo
 * cuando hace falta":
 *   - sin entrega        -> `off`   (no hay nada que revisar)
 *   - decisión/medición  -> `off`   (entregable explícito, no hay diff que revisar)
 *   - parche mecánico    -> `lite`  (1 revisor)
 *   - diff de producto   -> `full`  (2-3 revisores, nunca 7)
 *   - producción/datos   -> `human` (la firma de una persona; sin ella no cierra)
 */
export function decideLevel(facts: DeliveryFacts, config: EgmGateConfig = DEFAULT_CONFIG): EgmLevel {
  if (facts.signals.length === 0) return "off";
  if (facts.touchesHumanTopic) return "human";

  const hasCode = facts.signals.some((s) => s.kind === "pull_request" || s.kind === "patch");
  if (!hasCode) return "off";

  const lines = facts.diffLines ?? 0;
  const files = facts.diffFiles ?? 0;
  if (lines >= config.fullDiffLines || files >= config.fullDiffFiles) return "full";
  return "lite";
}

/** Evalúa si una issue puede quedar cerrada y con qué nivel de revisión. */
export function evaluateIssue(
  snapshot: IssueSnapshot,
  config: EgmGateConfig = DEFAULT_CONFIG,
): EvidenceEvaluation {
  const facts = collectDeliveryFacts(snapshot);
  const level = decideLevel(facts, config);

  if (facts.signals.length === 0) {
    const extra = facts.foreignPullRequests.length
      ? ` (el PR ${facts.foreignPullRequests.join(", ")} es de otro repo: no es la entrega de esta issue)`
      : "";
    return {
      ok: false,
      level: "off",
      kind: "none",
      signals: [],
      missing:
        "sin entrega verificable: falta un PR del repo del proyecto (github.com/<owner>/<repo>/pull/<n>), un parche adjunto (.patch/.diff) o una medición marcada `EGM-VERIFIED:` en el documento `plan`" +
        extra,
    };
  }

  // Una tarea que necesita a una persona no se cierra sola: hace falta la
  // firma registrada en el plan.
  if (level === "human" && !facts.humanApproval) {
    return {
      ok: false,
      level,
      kind: "none",
      signals: facts.signals,
      missing:
        "esta tarea toca producción, dinero o datos: falta la aprobación de una persona. Cuando la tengas, marcala en el documento `plan` como `EGM-APPROVED: <quien>` y la issue vuelve a cerrar sola.",
    };
  }

  const strongest = facts.signals.find((s) => s.kind === "pull_request")
    ?? facts.signals.find((s) => s.kind === "patch")
    ?? facts.signals.find((s) => s.kind === "human_approval")
    ?? facts.signals[0];

  return {
    ok: true,
    level,
    kind: strongest.kind,
    signals: facts.signals,
  };
}

/** Texto del comentario que el gate deja cuando falta la evidencia. */
export function buildGateComment(evaluation: EvidenceEvaluation, identifier: string): string {
  const lines = [
    `**Gate de entrega (${identifier}): falta evidencia.**`,
    "",
    evaluation.missing ?? "sin entrega verificable",
    "",
    "Qué se acepta como entrega, en este orden:",
    "1. un PR abierto del repo del proyecto (`github.com/<owner>/<repo>/pull/<n>`) en un comentario de esta issue;",
    "2. un parche adjunto (`.patch`/`.diff`);",
    "3. una medición real marcada `EGM-VERIFIED:` en el documento `plan` (con el comando y su salida);",
    "4. `EGM-DELIVERABLE: decision` en el `plan`, si esta issue no lleva código por diseño;",
    "5. `EGM-APPROVED: <quien>` en el `plan`, si la tarea necesita la aprobación de una persona.",
    "",
    "Un plan, un veredicto o un análisis **no** son una entrega: son el borrador de la entrega. La issue vuelve a `in_review` y sigue con el trabajo; no hace falta una card ni una decisión del dueño.",
  ];
  return lines.join("\n");
}
