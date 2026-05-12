import type { Edge } from "@xyflow/react";
import { usePluginData, useHostContext } from "@paperclipai/plugin-sdk/ui";
import type { StageDefinition, StageType, FanInStrategy } from "../../types.js";
import { DATA_KEYS } from "../constants.js";

interface AgentItem {
  id: string;
  name: string;
  role?: string;
}

interface ListAgentsResult {
  agents: AgentItem[];
}

interface EdgeInspectorProps {
  edge: Edge;
  stageIds: string[];
  onUpdate: (id: string, changes: Partial<{ label: string; sourceHandle: string; type: "default" | "error" | "loop"; activationKey: string; max_iterations: number }>) => void;
  onDelete: (id: string) => void;
}

function EdgeInspector({ edge, stageIds, onUpdate, onDelete }: EdgeInspectorProps) {
  const data = (edge.data ?? {}) as { sourceHandle?: string; type?: "default" | "error" | "loop"; activationKey?: string; max_iterations?: number };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ color: "#f9fafb", fontSize: 13, fontWeight: 600, borderBottom: "1px solid #374151", paddingBottom: 8 }}>
        Edge: {edge.source} → {edge.target}
      </div>

      <FieldGroup label="Label">
        <input
          style={inputStyle}
          value={String(edge.label ?? "")}
          onChange={(e) => onUpdate(edge.id, { label: e.target.value })}
          placeholder="Optional label"
        />
      </FieldGroup>

      {(edge.data as any)?.sourceHandle && (
        <FieldGroup label="Routes on decision">
          <div style={{ ...inputStyle, background: "#0f172a", color: "#9ca3af" }}>
            {(edge.data as any).sourceHandle}
          </div>
        </FieldGroup>
      )}

      <FieldGroup label="Edge type">
        <select
          style={selectStyle}
          value={data.type ?? "default"}
          onChange={(e) => onUpdate(edge.id, { type: e.target.value as "default" | "error" | "loop" })}
        >
          <option value="default">Default</option>
          <option value="error">Error</option>
          <option value="loop">Loop</option>
        </select>
      </FieldGroup>

      {data.type === "loop" && (
        <FieldGroup label="Max Iterations">
          <input
            type="number"
            style={inputStyle}
            value={data.max_iterations ?? 3}
            min={1}
            onChange={(e) => onUpdate(edge.id, { max_iterations: parseInt(e.target.value) || 1 })}
          />
        </FieldGroup>
      )}

      <FieldGroup label="Activation Key">
        <input
          style={inputStyle}
          value={data.activationKey ?? ""}
          onChange={(e) => onUpdate(edge.id, { activationKey: e.target.value })}
          placeholder="e.g. backend"
        />
      </FieldGroup>

      <button
        style={{ ...buttonStyle, background: "#7f1d1d", borderColor: "#991b1b", marginTop: 4 }}
        onClick={() => onDelete(edge.id)}
      >
        Delete Edge
      </button>
    </div>
  );
}

interface StageFormProps {
  stage: StageDefinition;
  agents: AgentItem[];
  schemas: string[];
  pipelineNames: string[];
  stageIds: string[];
  upstreamStageIds: string[];
  onChange: (updated: StageDefinition, oldId?: string) => void;
  onDelete: (id: string) => void;
}

function StageForm({ stage, agents, schemas, pipelineNames, stageIds, upstreamStageIds, onChange, onDelete }: StageFormProps) {
  const update = (patch: Partial<StageDefinition>) =>
    onChange({ ...stage, ...patch } as StageDefinition, patch.id !== undefined ? stage.id : undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ color: "#f9fafb", fontSize: 13, fontWeight: 600, borderBottom: "1px solid #374151", paddingBottom: 8 }}>
        Stage Inspector
      </div>

      <FieldGroup label="ID">
        <input
          style={inputStyle}
          value={stage.id}
          onChange={(e) => update({ id: e.target.value })}
        />
      </FieldGroup>

      <FieldGroup label="Type">
        <select
          style={selectStyle}
          value={stage.type}
          onChange={(e) => update({ type: e.target.value as StageType })}
        >
          <option value="stage">Stage</option>
          <option value="fan_out">Fan Out</option>
          <option value="fan_in">Fan In</option>
          <option value="sub-pipeline">Sub-Pipeline</option>
        </select>
      </FieldGroup>

      {(stage.type === "stage" || stage.type === "fan_out") && (
        <FieldGroup label="Agent Role">
          <select
            style={selectStyle}
            value={stage.agent_role ?? ""}
            onChange={(e) => update({ agent_role: e.target.value } as Partial<StageDefinition>)}
          >
            <option value="">— Select agent —</option>
            {agents.map((a) => (
              <option key={a.id} value={a.name}>{a.name}</option>
            ))}
          </select>
        </FieldGroup>
      )}

      {(stage.type === "stage" || stage.type === "fan_out") && (
        <FieldGroup label="Output Schema">
          <select
            style={selectStyle}
            value={stage.output_schema ?? ""}
            onChange={(e) => update({ output_schema: e.target.value || undefined } as Partial<StageDefinition>)}
          >
            <option value="">— No schema —</option>
            {schemas.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </FieldGroup>
      )}

      {(stage.type === "stage" || stage.type === "fan_out") && (
        <FieldGroup label="Instructions">
          <textarea
            style={{ ...inputStyle, minHeight: 120, resize: "vertical" }}
            value={"instructions" in stage ? (stage.instructions ?? "") : ""}
            onChange={(e) => update({ instructions: e.target.value || undefined } as any)}
            placeholder="Agent instructions..."
          />
        </FieldGroup>
      )}

      {stage.type === "fan_in" && (
        <FieldGroup label="Fan-In Strategy">
          <select
            style={selectStyle}
            value={(stage as { fan_in_strategy?: FanInStrategy }).fan_in_strategy ?? "all_complete"}
            onChange={(e) =>
              update({ fan_in_strategy: e.target.value as FanInStrategy } as Partial<StageDefinition>)
            }
          >
            <option value="all_complete">All Complete</option>
            <option value="first_complete">First Complete</option>
          </select>
        </FieldGroup>
      )}

      {stage.type === "sub-pipeline" && (
        <FieldGroup label="Pipeline Reference">
          <select
            style={selectStyle}
            value={stage.pipeline ?? ""}
            onChange={(e) => update({ pipeline: e.target.value } as Partial<StageDefinition>)}
          >
            <option value="">— Select pipeline —</option>
            {pipelineNames.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </FieldGroup>
      )}

      {(stage.type === "sub-pipeline" || stage.type === "fan_out") && (
        <>
          <FieldGroup label="Per Task">
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={(stage as any).per_task ?? false}
                onChange={(e) => update({ per_task: e.target.checked || undefined } as any)}
                style={{ accentColor: "#6366f1" }}
              />
              <span style={{ color: "#d1d5db", fontSize: 12 }}>Run per task from output</span>
            </label>
          </FieldGroup>
          <FieldGroup label="Ordering">
            <select
              style={selectStyle}
              value={(stage as any).ordering ?? ""}
              onChange={(e) => update({ ordering: e.target.value || undefined } as any)}
            >
              <option value="">— No ordering —</option>
              <option value="from_output">From output</option>
              <option value="sequential">Sequential</option>
              <option value="parallel">Parallel</option>
            </select>
          </FieldGroup>
        </>
      )}

      <button
        style={{ ...buttonStyle, background: "#7f1d1d", borderColor: "#991b1b" }}
        onClick={() => onDelete(stage.id)}
      >
        Delete Stage
      </button>
    </div>
  );
}

export interface StageInspectorProps {
  selectedStage: StageDefinition | null;
  selectedEdge: Edge | null;
  stageIds: string[];
  edges: { from: string; to: string }[];
  currentPipelineName: string;
  onStageChange: (updated: StageDefinition, oldId?: string) => void;
  onStageDelete: (id: string) => void;
  onEdgeUpdate: (id: string, changes: Partial<{ label: string; sourceHandle: string; type: "default" | "error" | "loop"; activationKey: string; max_iterations: number }>) => void;
  onEdgeDelete: (id: string) => void;
}

export function StageInspector({
  selectedStage,
  selectedEdge,
  stageIds,
  edges: edgeDefs,
  currentPipelineName,
  onStageChange,
  onStageDelete,
  onEdgeUpdate,
  onEdgeDelete,
}: StageInspectorProps) {
  const { companyId } = useHostContext();
  const { data: agentsData } = usePluginData<ListAgentsResult>(DATA_KEYS.LIST_AGENTS, { companyId });
  const { data: schemasData } = usePluginData<{ schemas: string[] }>(DATA_KEYS.LIST_SCHEMAS, {});
  const { data: pipelinesData } = usePluginData<{ pipelines: { name: string }[] }>(DATA_KEYS.LIST_PIPELINES, {});
  const agents = agentsData?.agents ?? [];
  const schemas = schemasData?.schemas ?? [];
  const pipelineNames = (pipelinesData?.pipelines ?? []).map((p) => p.name).filter((n) => n !== currentPipelineName);

  return (
    <div
      style={{
        width: 320,
        background: "#111827",
        borderLeft: "1px solid #374151",
        padding: 16,
        overflowY: "auto",
        flexShrink: 0,
        color: "#f9fafb",
        fontSize: 13,
      }}
    >
      {selectedEdge ? (
        <EdgeInspector edge={selectedEdge} stageIds={stageIds} onUpdate={onEdgeUpdate} onDelete={onEdgeDelete} />
      ) : selectedStage ? (
        <StageForm
          stage={selectedStage}
          agents={agents}
          schemas={schemas}
          pipelineNames={pipelineNames}
          stageIds={stageIds}
          upstreamStageIds={edgeDefs.filter((e) => e.to === selectedStage.id).map((e) => e.from)}
          onChange={onStageChange}
          onDelete={onStageDelete}
        />
      ) : (
        <div style={{ color: "#6b7280", fontSize: 12, textAlign: "center", marginTop: 48, lineHeight: 1.6 }}>
          Click a stage node or edge to inspect and edit its properties.
        </div>
      )}
    </div>
  );
}

// Shared field components

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ color: "#9ca3af", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#1f2937",
  border: "1px solid #374151",
  borderRadius: 6,
  color: "#f9fafb",
  fontSize: 12,
  padding: "6px 8px",
  width: "100%",
  outline: "none",
  boxSizing: "border-box",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};

const buttonStyle: React.CSSProperties = {
  background: "#1f2937",
  border: "1px solid #374151",
  borderRadius: 6,
  color: "#f9fafb",
  fontSize: 12,
  fontWeight: 600,
  padding: "7px 12px",
  cursor: "pointer",
  width: "100%",
};
