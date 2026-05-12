import xyflowStyles from "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
} from "@xyflow/react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { StagePalette } from "./StagePalette.js";
import { StageNode, type StageNodeData } from "./StageNode.js";
import { StageInspector } from "./StageInspector.js";
import { useAutoLayout } from "../hooks/useAutoLayout.js";
import { ACTION_KEYS, DATA_KEYS } from "../constants.js";
import { validatePipeline, ValidationErrorsPanel, type ValidationError } from "./ValidationErrors.js";
import { getDecisionEnumValues, type JsonSchema } from "../../schema-utils.js";
import type { PipelineDefinition, StageDefinition, StageType, EdgeDefinition } from "../../types.js";

const NODE_TYPES = { stage: StageNode };

function buildEdges(pipeline: PipelineDefinition): Edge[] {
  return (pipeline.edges ?? []).map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    sourceHandle: e.sourceHandle ?? null,
    label: e.sourceHandle ?? e.label,
    data: { type: e.type, sourceHandle: e.sourceHandle },
    style: { stroke: e.type === "error" ? "#ef4444" : "#4b5563", strokeWidth: 2 },
    animated: false,
  }));
}

function stageDefaults(type: StageType, id: string): StageDefinition {
  switch (type) {
    case "stage":
      return { id, type: "stage", agent_role: "" };
    case "fan_out":
      return { id, type: "fan_out" };
    case "fan_in":
      return { id, type: "fan_in", fan_in_strategy: "all_complete" };
    case "sub-pipeline":
      return { id, type: "sub-pipeline", pipeline: "" };
  }
}

let nodeSeq = 1;

export interface PipelineCanvasProps {
  pipeline: PipelineDefinition;
  companyId: string | null;
  onSaved?: () => void;
}

export function PipelineCanvas({ pipeline, companyId, onSaved }: PipelineCanvasProps) {
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = xyflowStyles;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, []);

  const savePipeline = usePluginAction(ACTION_KEYS.SAVE_PIPELINE);

  // Fetch schema contents for decision enum values
  const { data: schemaContents } = usePluginData<{ schemas: Record<string, JsonSchema> }>(
    DATA_KEYS.LIST_SCHEMA_CONTENTS, {}
  );

  const decisionMap = useMemo(() => {
    const map: Record<string, string[]> = {};
    if (!schemaContents?.schemas) return map;
    for (const [name, schema] of Object.entries(schemaContents.schemas)) {
      map[name] = getDecisionEnumValues(schema);
    }
    return map;
  }, [schemaContents]);

  // Local copies of pipeline metadata
  const [name, setName] = useState(pipeline.name);
  const [description, setDescription] = useState(pipeline.description);
  const [triggerLabel, setTriggerLabel] = useState(pipeline.trigger?.label ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Stages as mutable state
  const [stages, setStages] = useState<StageDefinition[]>(pipeline.stages ?? []);
  const [edgeDefs, setEdgeDefs] = useState<EdgeDefinition[]>(pipeline.edges ?? []);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(
    pipeline.positions ?? {},
  );

  // Selection state
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const handleNodeSelect = useCallback((id: string) => {
    setSelectedStageId(id);
    setSelectedEdgeId(null);
  }, []);

  // Build RF nodes/edges from canonical state
  const rfNodes = useMemo(() =>
    stages.map((stage) => {
      const schemaName = "output_schema" in stage ? stage.output_schema : undefined;
      const decisionValues = schemaName ? decisionMap[schemaName] ?? [] : [];
      return {
        id: stage.id,
        type: "stage" as const,
        position: positions[stage.id] ?? { x: 0, y: 0 },
        data: { stage, decisionValues, selected: stage.id === selectedStageId, onSelect: handleNodeSelect } as unknown as StageNodeData,
      };
    }),
    [stages, positions, selectedStageId, handleNodeSelect, decisionMap],
  );

  const rfEdges = useMemo<Edge[]>(() =>
    edgeDefs.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      sourceHandle: e.sourceHandle ?? null,
      label: e.sourceHandle ?? e.label,
      data: { type: e.type, sourceHandle: e.sourceHandle },
      style: { stroke: e.type === "error" ? "#ef4444" : "#4b5563", strokeWidth: 2 },
      selected: e.id === selectedEdgeId,
    })),
    [edgeDefs, selectedEdgeId],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes as unknown as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rfEdges);

  const autoLayout = useAutoLayout;

  const handleAutoLayout = useCallback(() => {
    const newPositions = autoLayout(nodes, edges);
    setPositions((prev) => ({ ...prev, ...newPositions }));
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        position: newPositions[n.id] ?? n.position,
      })),
    );
  }, [nodes, edges, autoLayout, setNodes]);

  const handleConnect = useCallback(
    (connection: Connection) => {
      const newEdge: EdgeDefinition = {
        id: `e-${connection.source}-${connection.target}-${Date.now()}`,
        from: connection.source ?? "",
        to: connection.target ?? "",
        type: "default",
        sourceHandle: connection.sourceHandle ?? undefined,
      };
      setEdgeDefs((prev) => [...prev, newEdge]);
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            id: newEdge.id,
            style: { stroke: "#4b5563", strokeWidth: 2 },
          },
          eds,
        ),
      );
    },
    [setEdges],
  );

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedStageId(node.id);
    setSelectedEdgeId(null);
  }, []);

  const handleSelectionChange = useCallback(({ nodes: selectedNodes }: { nodes: Node[]; edges: Edge[] }) => {
    if (selectedNodes.length === 1) {
      setSelectedStageId(selectedNodes[0].id);
      setSelectedEdgeId(null);
    } else if (selectedNodes.length === 0) {
      setSelectedStageId(null);
    }
  }, []);

  const handleEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setSelectedEdgeId(edge.id);
    setSelectedStageId(null);
  }, []);

  const handlePaneClick = useCallback(() => {
    setSelectedStageId(null);
    setSelectedEdgeId(null);
  }, []);

  const handleNodeDragStop = useCallback((_: React.MouseEvent, node: Node) => {
    setPositions((prev) => ({ ...prev, [node.id]: node.position }));
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const type = e.dataTransfer.getData("application/pipeline-stage-type") as StageType;
      if (!type) return;
      const id = `${type}-${nodeSeq++}`;
      const newStage = stageDefaults(type, id);

      // Calculate drop position relative to canvas
      const bounds = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const pos = {
        x: e.clientX - bounds.left - 100,
        y: e.clientY - bounds.top - 45,
      };

      setStages((prev) => [...prev, newStage]);
      setPositions((prev) => ({ ...prev, [id]: pos }));
      setNodes((nds) => [
        ...nds,
        {
          id,
          type: "stage" as const,
          position: pos,
          data: { stage: newStage, decisionValues: [], onSelect: handleNodeSelect } as unknown as StageNodeData,
        } as unknown as Node,
      ]);
    },
    [setNodes, handleNodeSelect],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleStageChange = useCallback((updated: StageDefinition, oldId?: string) => {
    const prevId = oldId ?? updated.id;
    const newId = updated.id;
    const idChanged = prevId !== newId;

    setStages((prev) => prev.map((s) => (s.id === prevId ? updated : s)));

    if (idChanged) {
      setEdgeDefs((prev) =>
        prev.map((e) => ({
          ...e,
          id: e.id.replace(prevId, newId),
          from: e.from === prevId ? newId : e.from,
          to: e.to === prevId ? newId : e.to,
        })),
      );
      setEdges((eds) =>
        eds.map((e) => ({
          ...e,
          id: e.id.replace(prevId, newId),
          source: e.source === prevId ? newId : e.source,
          target: e.target === prevId ? newId : e.target,
        })),
      );
      setSelectedStageId(newId);
    }

    const schemaName = "output_schema" in updated ? updated.output_schema : undefined;
    const dv = schemaName ? decisionMap[schemaName] ?? [] : [];
    setNodes((nds) =>
      nds.map((n) =>
        n.id === prevId
          ? ({ ...n, id: newId, data: { ...n.data, stage: updated, decisionValues: dv, onSelect: handleNodeSelect } as unknown as StageNodeData } as unknown as Node)
          : n,
      ),
    );
    if (idChanged) {
      setPositions((prev) => {
        const { [prevId]: pos, ...rest } = prev;
        return { ...rest, [newId]: pos };
      });
    }
  }, [setNodes, setEdges, handleNodeSelect, decisionMap]);

  const handleStageDelete = useCallback((id: string) => {
    setStages((prev) => prev.filter((s) => s.id !== id));
    setEdgeDefs((prev) => prev.filter((e) => e.from !== id && e.to !== id));
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    setSelectedStageId(null);
  }, [setNodes, setEdges]);

  const handleEdgeUpdate = useCallback(
    (id: string, changes: Partial<{ label: string; sourceHandle: string; type: "default" | "error" }>) => {
      setEdgeDefs((prev) =>
        prev.map((e) =>
          e.id === id ? { ...e, ...changes } : e,
        ),
      );
      setEdges((eds) =>
        eds.map((e) =>
          e.id === id
            ? {
                ...e,
                ...(changes.label !== undefined ? { label: changes.label } : {}),
                ...(changes.sourceHandle !== undefined ? { sourceHandle: changes.sourceHandle, label: changes.sourceHandle } : {}),
                ...(changes.type !== undefined
                  ? { style: { stroke: changes.type === "error" ? "#ef4444" : "#4b5563", strokeWidth: 2 } }
                  : {}),
                data: { ...(e.data ?? {}), ...changes },
              }
            : e,
        ),
      );
    },
    [setEdges],
  );

  const handleEdgeDelete = useCallback(
    (id: string) => {
      setEdgeDefs((prev) => prev.filter((e) => e.id !== id));
      setEdges((eds) => eds.filter((e) => e.id !== id));
      setSelectedEdgeId(null);
    },
    [setEdges],
  );

  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);

  const handleSave = useCallback(async () => {
    const errors = validatePipeline(name, stages, edgeDefs);
    if (errors.length > 0) {
      setValidationErrors(errors);
      return;
    }
    setValidationErrors([]);
    setSaving(true);
    setSaveError(null);
    try {
      const updatedPipeline: PipelineDefinition = {
        name,
        description,
        trigger: { label: triggerLabel },
        stages,
        edges: edgeDefs,
        positions,
      };
      await savePipeline({ name, content: JSON.stringify(updatedPipeline) });
      onSaved?.();
    } catch (err) {
      setSaveError((err as Error).message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }, [name, description, triggerLabel, stages, edgeDefs, positions, savePipeline, onSaved]);

  const selectedStage = stages.find((s) => s.id === selectedStageId) ?? null;
  const selectedEdge = edgeDefs.find((e) => e.id === selectedEdgeId) ?? null;
  const selectedRfEdge = edges.find((e) => e.id === selectedEdgeId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#111827" }}>
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          borderBottom: "1px solid #374151",
          background: "#111827",
          flexShrink: 0,
          flexWrap: "wrap",
        }}
      >
        <input
          style={{
            ...toolbarInputStyle,
            fontWeight: 600,
            fontSize: 14,
            width: 180,
          }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Pipeline name"
        />
        <input
          style={{ ...toolbarInputStyle, width: 260, color: "#9ca3af" }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
        />
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "#9ca3af", fontSize: 11 }}>Trigger label:</span>
          <input
            style={{ ...toolbarInputStyle, width: 140 }}
            value={triggerLabel}
            onChange={(e) => setTriggerLabel(e.target.value)}
            placeholder="e.g. pipeline:feature"
          />
        </div>
        <div style={{ flex: 1 }} />
        <button
          style={{ ...toolbarButtonStyle, background: "#1e3a5f", borderColor: "#2563eb" }}
          onClick={handleAutoLayout}
        >
          Auto Layout
        </button>
        <button
          style={{
            ...toolbarButtonStyle,
            background: saving ? "#1f2937" : "#1e3a5f",
            borderColor: saving ? "#374151" : "#4f46e5",
            opacity: saving ? 0.7 : 1,
          }}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saveError && (
          <span style={{ color: "#ef4444", fontSize: 11 }}>{saveError}</span>
        )}
      </div>

      {/* Three-panel layout */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <StagePalette />

        {/* ReactFlow canvas */}
        <div
          style={{ flex: 1, position: "relative" }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={handleConnect}
            onNodeClick={handleNodeClick}
            onEdgeClick={handleEdgeClick}
            onPaneClick={handlePaneClick}
            onNodeDragStop={handleNodeDragStop}
            onSelectionChange={handleSelectionChange}
            fitView
            style={{ background: "#0f172a" }}
          >
            <Background color="#1f2937" gap={20} size={1} />
            <Controls style={{ background: "#1f2937", border: "1px solid #374151" }} />
          </ReactFlow>
          <ValidationErrorsPanel
            errors={validationErrors}
            onClickStage={(id) => { setSelectedStageId(id); setSelectedEdgeId(null); }}
            onDismiss={() => setValidationErrors([])}
          />
        </div>

        <StageInspector
          selectedStage={selectedStage}
          selectedEdge={selectedRfEdge}
          stageIds={stages.map((s) => s.id)}
          edges={edgeDefs}
          currentPipelineName={name}
          onStageChange={handleStageChange}
          onStageDelete={handleStageDelete}
          onEdgeUpdate={handleEdgeUpdate}
          onEdgeDelete={handleEdgeDelete}
        />
      </div>
    </div>
  );
}

const toolbarInputStyle: React.CSSProperties = {
  background: "#1f2937",
  border: "1px solid #374151",
  borderRadius: 6,
  color: "#f9fafb",
  fontSize: 12,
  padding: "5px 8px",
  outline: "none",
};

const toolbarButtonStyle: React.CSSProperties = {
  background: "#1f2937",
  border: "1px solid #374151",
  borderRadius: 6,
  color: "#f9fafb",
  fontSize: 12,
  fontWeight: 600,
  padding: "5px 12px",
  cursor: "pointer",
};
