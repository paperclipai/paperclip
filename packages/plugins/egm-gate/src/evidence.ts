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

const PR_PATTERN = /https?:\/\/(?:www\.)?github\.com\/([^\s)]+)\/pull\/(\d+)/i;
const VERIFIED_PATTERN = /^\s*EGM-VERIFIED\s*:/im;
const DELIVERABLE_DECISION_PATTERN = /^\s*EGM-DELIVERABLE\s*:\s*decision\s*$/im;
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
};

export function collectDeliveryFacts(snapshot: IssueSnapshot): DeliveryFacts {
  const signals: EvidenceSignal[] = [];
  const foreignPullRequests: string[] = [];
  let diffLines: number | undefined;
  let diffFiles: number | undefined;
  const expected = snapshot.expectedRepo ? snapshot.expectedRepo.toLowerCase() : null;

  for (const comment of snapshot.comments) {
    const match = PR_PATTERN.exec(comment.body);
    if (!match) continue;
    const slug = `${match[1]}/${match[2]}`.replace(/[^\w./-]/g, "");
    const repo = slug.split("/").slice(0, 2).join("/");
    // Un PR de otro repo no es la entrega de esta issue.
    if (expected && repo.toLowerCase() !== expected) {
      foreignPullRequests.push(`${repo}/pull/${match[2]}`);
      continue;
    }
    signals.push({ kind: "pull_request", ref: `https://github.com/${repo}/pull/${match[2]}`, source: "comment" });
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

  return { signals, diffLines, diffFiles, touchesHumanTopic, foreignPullRequests };
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
