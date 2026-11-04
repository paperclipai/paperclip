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
 *   1. PR real (link a github.com/<owner>/<repo>/pull/<n>) en un comentario.
 *   2. Parche adjunto (attachment .patch/.diff).
 *   3. Medición verificada declarada en el documento `plan` (`EGM-VERIFIED:`).
 *   4. Decisión documentada (`EGM-DELIVERABLE: decision`) — para issues que no
 *      llevan código (una decisión del dueño, un veredicto, un análisis pedido).
 * Ninguna de las dos últimas requiere código: son entregables explícitos.
 */

const PR_PATTERN = /https?:\/\/(?:www\.)?github\.com\/[^\s)]+\/pull\/\d+/i;
const VERIFIED_PATTERN = /^\s*EGM-VERIFIED\s*:/im;
const DELIVERABLE_DECISION_PATTERN = /^\s*EGM-DELIVERABLE\s*:\s*decision\s*$/im;
const DIFF_PATTERN = /^\s*EGM-DIFF\s*:\s*(\d+)\s+lines?\s+(\d+)\s+files?/im;

export type DeliveryFacts = {
  signals: EvidenceSignal[];
  /** Líneas de diff declaradas, si el plan las declara. */
  diffLines?: number;
  diffFiles?: number;
  /** El texto de la issue menciona un tema que exige aprobación humana. */
  touchesHumanTopic: boolean;
};

export function collectDeliveryFacts(snapshot: IssueSnapshot): DeliveryFacts {
  const signals: EvidenceSignal[] = [];
  let diffLines: number | undefined;
  let diffFiles: number | undefined;

  for (const comment of snapshot.comments) {
    const match = comment.body.match(PR_PATTERN);
    if (match) {
      signals.push({ kind: "pull_request", ref: match[0], source: "comment" });
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
  const diff = plan.match(DIFF_PATTERN);
  if (diff) {
    diffLines = Number(diff[1]);
    diffFiles = Number(diff[2]);
  }

  const haystack = `${snapshot.title}\n${plan}`.toLowerCase();
  const touchesHumanTopic = DEFAULT_CONFIG.humanTopics.some((topic) => haystack.includes(topic));

  return { signals, diffLines, diffFiles, touchesHumanTopic };
}

/**
 * Decide el nivel de revisión de una tarea. Éste es el corazón de "EGM sólo
 * cuando hace falta":
 *   - sin entrega        -> `off`   (no hay nada que revisar)
 *   - decisión/medición  -> `off`   (entregable explícito, no hay diff que revisar)
 *   - parche mecánico    -> `lite`  (1 revisor)
 *   - diff de producto   -> `full`  (2-3 revisores, nunca 7)
 *   - producción/datos   -> `human` (aprobación humana nativa, no IA)
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
    return {
      ok: false,
      level: "off",
      kind: "none",
      signals: [],
      missing:
        "sin entrega verificable: falta un PR (github.com/<owner>/<repo>/pull/<n>), un parche adjunto (.patch/.diff) o una medición marcada `EGM-VERIFIED:` en el documento `plan`",
    };
  }

  const strongest = facts.signals.find((s) => s.kind === "pull_request")
    ?? facts.signals.find((s) => s.kind === "patch")
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
    "1. un PR abierto (`github.com/<owner>/<repo>/pull/<n>`) en un comentario de esta issue;",
    "2. un parche adjunto (`.patch`/`.diff`);",
    "3. una medición real marcada `EGM-VERIFIED:` en el documento `plan` (con el comando y su salida);",
    "4. `EGM-DELIVERABLE: decision` en el `plan`, si esta issue no lleva código por diseño.",
    "",
    "Un plan, un veredicto o un análisis **no** son una entrega: son el borrador de la entrega. La issue vuelve a `in_review` y sigue con el trabajo; no hace falta una card ni una decisión del dueño.",
  ];
  return lines.join("\n");
}
