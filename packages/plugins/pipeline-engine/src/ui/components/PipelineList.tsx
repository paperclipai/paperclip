import { useState } from "react";
import { usePluginData, usePluginAction, useHostContext } from "@paperclipai/plugin-sdk/ui";
import { PipelineCanvas } from "./PipelineCanvas.js";
import { DATA_KEYS, ACTION_KEYS } from "../constants.js";
import type { PipelineDefinition } from "../../types.js";

interface PipelineListItem {
  name: string;
  description: string;
  stageCount: number;
  edgeCount: number;
}

interface ListPipelinesResult {
  pipelines: PipelineListItem[];
}

interface GetPipelineResult {
  pipeline: PipelineDefinition;
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        flex: 1,
        gap: 16,
        color: "#9ca3af",
      }}
    >
      <div style={{ fontSize: 48, opacity: 0.3 }}>≋</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: "#f9fafb" }}>No pipelines yet</div>
      <div style={{ fontSize: 13, maxWidth: 320, textAlign: "center", lineHeight: 1.6 }}>
        Create your first pipeline to start orchestrating agent workflows.
      </div>
      <button
        style={{
          background: "#4f46e5",
          border: "none",
          borderRadius: 6,
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
          padding: "8px 20px",
          cursor: "pointer",
        }}
        onClick={onCreate}
      >
        Create Pipeline
      </button>
    </div>
  );
}

function newEmptyPipeline(): PipelineDefinition {
  return {
    name: "Untitled Pipeline",
    description: "",
    trigger: { label: "" },
    stages: [],
    edges: [],
    positions: {},
  };
}

function PipelineListView({ companyId, onEdit }: { companyId: string | null; onEdit: (name: string) => void }) {
  const { data, loading, error, refresh } = usePluginData<ListPipelinesResult>(DATA_KEYS.LIST_PIPELINES, {
    companyId,
  });
  const deletePipeline = usePluginAction(ACTION_KEYS.DELETE_PIPELINE);
  const [deleting, setDeleting] = useState<string | null>(null);

  if (loading) {
    return (
      <div style={{ padding: 32, color: "#9ca3af", textAlign: "center" }}>
        Loading pipelines...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 32, color: "#ef4444", textAlign: "center" }}>
        Error: {error.message}
      </div>
    );
  }

  const pipelines = data?.pipelines ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {pipelines.length === 0 ? null : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            color: "#f9fafb",
            fontSize: 13,
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid #374151" }}>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Description</th>
              <th style={{ ...thStyle, width: 80, textAlign: "center" }}>Stages</th>
              <th style={{ ...thStyle, width: 80, textAlign: "center" }}>Edges</th>
              <th style={{ ...thStyle, width: 120 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pipelines.map((p) => (
              <tr
                key={p.name}
                style={{ borderBottom: "1px solid #1f2937" }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = "#1f2937";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = "transparent";
                }}
              >
                <td style={{ ...tdStyle, fontWeight: 600 }}>{p.name}</td>
                <td style={{ ...tdStyle, color: "#9ca3af" }}>{p.description || "—"}</td>
                <td style={{ ...tdStyle, textAlign: "center", color: "#9ca3af" }}>{p.stageCount}</td>
                <td style={{ ...tdStyle, textAlign: "center", color: "#9ca3af" }}>{p.edgeCount}</td>
                <td style={tdStyle}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      style={actionBtnStyle}
                      onClick={() => onEdit(p.name)}
                    >
                      Edit
                    </button>
                    <button
                      style={{ ...actionBtnStyle, borderColor: "#991b1b", color: "#ef4444", opacity: deleting === p.name ? 0.5 : 1 }}
                      disabled={deleting === p.name}
                      onClick={async () => {
                        setDeleting(p.name);
                        try {
                          await deletePipeline({ companyId, name: p.name });
                          refresh();
                        } finally {
                          setDeleting(null);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PipelineEditorView({
  pipelineName,
  companyId,
  onBack,
}: {
  pipelineName: string | null;
  companyId: string | null;
  onBack: () => void;
}) {
  const { data, loading, error } = usePluginData<GetPipelineResult>(DATA_KEYS.GET_PIPELINE, {
    companyId,
    name: pipelineName,
  });

  if (loading) {
    return (
      <div style={{ padding: 32, color: "#9ca3af", textAlign: "center" }}>
        Loading pipeline...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 32, color: "#ef4444", textAlign: "center" }}>
        Error: {error.message}
      </div>
    );
  }

  const pipeline = data?.pipeline ?? (pipelineName === null ? newEmptyPipeline() : null);
  if (!pipeline) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid #374151", display: "flex", alignItems: "center", gap: 12 }}>
        <button
          style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}
          onClick={onBack}
        >
          ← Back to pipelines
        </button>
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        <PipelineCanvas
          pipeline={pipeline}
          companyId={companyId}
          onSaved={onBack}
        />
      </div>
    </div>
  );
}

export function PipelinesPage() {
  const { companyId } = useHostContext();
  const [editingPipeline, setEditingPipeline] = useState<string | null | "new">(null);
  const { data, refresh } = usePluginData<ListPipelinesResult>(DATA_KEYS.LIST_PIPELINES, { companyId });

  const handleCreate = () => setEditingPipeline("new");
  const handleEdit = (name: string) => setEditingPipeline(name);
  const handleBack = () => {
    setEditingPipeline(null);
    refresh();
  };

  if (editingPipeline !== null) {
    return (
      <div style={{ height: "100%", background: "#111827", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <PipelineEditorView
          pipelineName={editingPipeline === "new" ? null : editingPipeline}
          companyId={companyId}
          onBack={handleBack}
        />
      </div>
    );
  }

  const pipelines = data?.pipelines ?? [];

  return (
    <div style={{ height: "100%", background: "#111827", display: "flex", flexDirection: "column", color: "#f9fafb" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 24px",
          borderBottom: "1px solid #374151",
          flexShrink: 0,
        }}
      >
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Pipelines</div>
          <div style={{ color: "#9ca3af", fontSize: 13, marginTop: 2 }}>
            Manage deterministic agent workflow pipelines
          </div>
        </div>
        <button
          style={{
            background: "#4f46e5",
            border: "none",
            borderRadius: 6,
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            padding: "8px 20px",
            cursor: "pointer",
          }}
          onClick={handleCreate}
        >
          New Pipeline
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "0 24px" }}>
        {pipelines.length === 0 ? (
          <EmptyState onCreate={handleCreate} />
        ) : (
          <PipelineListView companyId={companyId} onEdit={handleEdit} />
        )}
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "10px 12px",
  textAlign: "left",
  color: "#9ca3af",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
  verticalAlign: "middle",
};

const actionBtnStyle: React.CSSProperties = {
  background: "#1f2937",
  border: "1px solid #374151",
  borderRadius: 5,
  color: "#f9fafb",
  fontSize: 11,
  fontWeight: 600,
  padding: "4px 10px",
  cursor: "pointer",
};
