/**
 * Contratos del plugin `egm-gate`.
 *
 * Idea: el EGM (o cualquier revisión) se aplica SOLO cuando la tarea entregó
 * algo revisable, y una issue no se cierra sin evidencia de entrega. Nada de
 * esto mira el texto del documento: mira hechos.
 */

/** Nivel de revisión que una tarea necesita. */
export type EgmLevel = "off" | "lite" | "full" | "human";

/** Qué se entregó en la issue (lo que el gate puede verificar de verdad). */
export type DeliveryKind =
  | "pull_request"
  | "patch"
  | "measurement"
  | "decision"
  | "human_approval"
  | "none";

export type EvidenceSignal = {
  kind: DeliveryKind;
  /** Referencia legible: URL del PR, nombre del adjunto o id del documento. */
  ref: string;
  /** De dónde salió la señal. */
  source: "comment" | "attachment" | "document";
};

export type EvidenceEvaluation = {
  ok: boolean;
  /** Nivel de revisión que corresponde a la entrega detectada. */
  level: EgmLevel;
  kind: DeliveryKind;
  signals: EvidenceSignal[];
  /** Motivo corto y accionable cuando `ok` es false. */
  missing?: string;
};

/** Entradas que el gate lee de la issue. */
export type IssueSnapshot = {
  issueId: string;
  companyId: string;
  identifier: string;
  title: string;
  /** Descripción de la issue: también dice qué toca (producción, dinero...). */
  description?: string | null;
  status: string;
  priority: string;
  /** Proyecto al que pertenece la issue (frontera de acceso de un agente). */
  projectId?: string | null;
  /** Agente asignado a la issue (frontera de acceso de un agente). */
  assigneeAgentId?: string | null;
  comments: { id: string; body: string; createdAt?: string }[];
  attachments: { id: string; fileName?: string | null; contentType?: string | null }[];
  /** Cuerpo del documento `plan` de la issue, si existe. */
  planBody?: string | null;
  /**
   * Repo `owner/name` del proyecto (el de su workspace principal). Si se conoce,
   * un PR de otro repo NO cuenta como entrega: sin esto un agent cerraba la issue
   * pegando el link de un PR viejo o de otro proyecto.
   */
  expectedRepo?: string | null;
};

/** Reglas de umbral, configurables por instancia. */
export type EgmGateConfig = {
  /** Líneas de diff a partir de las cuales la revisión pasa a `full`. */
  fullDiffLines: number;
  /** Archivos de diff a partir de los cuales la revisión pasa a `full`. */
  fullDiffFiles: number;
  /** Temas que siempre pasan a aprobación humana. */
  humanTopics: string[];
  /** Devolver a `in_review` (true) o dejar el issue en `todo` (false) sin evidencia. */
  reopenAsInReview: boolean;
};

export const DEFAULT_CONFIG: EgmGateConfig = {
  fullDiffLines: 300,
  fullDiffFiles: 8,
  humanTopics: ["production", "produccion", "deploy", "billing", "pago", "datos", "migracion", "migration", "secret", "secreto"],
  reopenAsInReview: true,
};
