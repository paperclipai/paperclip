import type { StageDefinition, EdgeDefinition } from "../../types.js";

export interface ValidationError {
  stageId?: string;
  edgeId?: string;
  field: string;
  message: string;
}

export function validatePipeline(
  name: string,
  stages: StageDefinition[],
  edges: EdgeDefinition[],
  decisionMap?: Record<string, string[]>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!name.trim()) {
    errors.push({ field: "name", message: "Pipeline name is required" });
  }

  if (stages.length === 0) {
    errors.push({ field: "stages", message: "Pipeline must have at least one stage" });
  }

  const ids = new Set<string>();
  for (const stage of stages) {
    if (!stage.id.trim()) {
      errors.push({ stageId: stage.id, field: "id", message: "Stage ID cannot be empty" });
    }
    if (ids.has(stage.id)) {
      errors.push({ stageId: stage.id, field: "id", message: `Duplicate stage ID "${stage.id}"` });
    }
    ids.add(stage.id);

    if (stage.type === "stage" && !stage.agent_role) {
      errors.push({ stageId: stage.id, field: "agent_role", message: `"${stage.id}" requires an agent role` });
    }

    if (stage.type === "sub-pipeline" && !stage.pipeline) {
      errors.push({ stageId: stage.id, field: "pipeline", message: `"${stage.id}" requires a pipeline reference` });
    }
    if (stage.type === "sub-pipeline" && stage.pipeline === name) {
      errors.push({ stageId: stage.id, field: "pipeline", message: `"${stage.id}" cannot reference itself` });
    }
  }

  for (const edge of edges) {
    if (!ids.has(edge.from)) {
      errors.push({ edgeId: edge.id, field: "from", message: `Edge "${edge.id}" references missing stage "${edge.from}"` });
    }
    if (!ids.has(edge.to)) {
      errors.push({ edgeId: edge.id, field: "to", message: `Edge "${edge.id}" references missing stage "${edge.to}"` });
    }
    if (edge.type === "loop" && (!edge.max_iterations || edge.max_iterations <= 0)) {
      errors.push({ edgeId: edge.id, field: "max_iterations", message: `Loop edge "${edge.id}" must have max_iterations > 0` });
    }
  }

  if (decisionMap) {
    for (const stage of stages) {
      if (stage.type !== "stage") continue;
      const schemaName = stage.output_schema;
      if (!schemaName) continue;
      const enumValues = decisionMap[schemaName];
      if (!enumValues || enumValues.length === 0) continue;

      const outgoingEdges = edges.filter((e) => e.from === stage.id && e.type !== "error");
      const coveredValues = new Set(outgoingEdges.map((e) => e.sourceHandle).filter(Boolean));

      for (const value of enumValues) {
        if (!coveredValues.has(value)) {
          errors.push({
            stageId: stage.id,
            field: "edges",
            message: `Missing outgoing edge for decision "${value}" on "${stage.id}"`,
          });
        }
      }
    }
  }

  return errors;
}

interface ValidationErrorsPanelProps {
  errors: ValidationError[];
  onClickStage: (id: string) => void;
  onDismiss: () => void;
}

export function ValidationErrorsPanel({ errors, onClickStage, onDismiss }: ValidationErrorsPanelProps) {
  if (errors.length === 0) return null;

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ color: "#fca5a5", fontSize: 12, fontWeight: 700 }}>
          {errors.length} validation error{errors.length > 1 ? "s" : ""}
        </span>
        <button style={dismissStyle} onClick={onDismiss}>✕</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 120, overflowY: "auto" }}>
        {errors.map((err, i) => (
          <div
            key={i}
            style={errorRowStyle}
            onClick={() => err.stageId && onClickStage(err.stageId)}
          >
            <span style={{ color: "#ef4444", fontSize: 11 }}>●</span>
            <span style={{ color: "#e5e7eb", fontSize: 11 }}>{err.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 16,
  left: "50%",
  transform: "translateX(-50%)",
  background: "#1f2937",
  border: "1px solid #991b1b",
  borderRadius: 8,
  padding: "10px 14px",
  minWidth: 320,
  maxWidth: 500,
  zIndex: 100,
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
};

const dismissStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#9ca3af",
  fontSize: 14,
  cursor: "pointer",
  padding: "0 4px",
};

const errorRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
  padding: "3px 4px",
  borderRadius: 4,
};
