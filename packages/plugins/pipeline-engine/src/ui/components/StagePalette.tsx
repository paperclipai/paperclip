import type { StageType } from "../../types.js";

interface StageTypeCard {
  type: StageType;
  label: string;
  description: string;
  color: string;
  badge: string;
}

const STAGE_TYPES: StageTypeCard[] = [
  {
    type: "stage",
    label: "Stage",
    description: "Agent performs work and routes by decision",
    color: "#3b82f6",
    badge: "STG",
  },
  {
    type: "fan_out",
    label: "Fan Out",
    description: "Distribute work across multiple parallel agents",
    color: "#06b6d4",
    badge: "FAN",
  },
  {
    type: "fan_in",
    label: "Fan In",
    description: "Wait for parallel branches to complete",
    color: "#8b5cf6",
    badge: "FIN",
  },
  {
    type: "sub-pipeline",
    label: "Sub-Pipeline",
    description: "Invoke a nested pipeline definition",
    color: "#22c55e",
    badge: "SUB",
  },
];

export function StagePalette() {
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, type: StageType) => {
    e.dataTransfer.setData("application/pipeline-stage-type", type);
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div
      style={{
        width: 180,
        background: "#111827",
        borderRight: "1px solid #374151",
        padding: "12px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        overflowY: "auto",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          color: "#9ca3af",
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          padding: "0 4px 8px",
          borderBottom: "1px solid #374151",
          marginBottom: 4,
        }}
      >
        Stage Types
      </div>
      {STAGE_TYPES.map((card) => (
        <div
          key={card.type}
          draggable
          onDragStart={(e) => handleDragStart(e, card.type)}
          style={{
            background: "#1f2937",
            border: "1px solid #374151",
            borderRadius: 6,
            padding: "8px 10px",
            cursor: "grab",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            position: "relative",
            overflow: "hidden",
            transition: "border-color 0.15s",
            userSelect: "none",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLDivElement).style.borderColor = card.color;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLDivElement).style.borderColor = "#374151";
          }}
        >
          {/* Left color strip */}
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: 3,
              background: card.color,
              borderRadius: "6px 0 0 6px",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingLeft: 4 }}>
            <span style={{ color: "#f9fafb", fontSize: 12, fontWeight: 600 }}>{card.label}</span>
            <span
              style={{
                background: card.color + "33",
                color: card.color,
                border: `1px solid ${card.color}66`,
                borderRadius: 3,
                fontSize: 8,
                fontWeight: 700,
                padding: "1px 3px",
                letterSpacing: "0.05em",
              }}
            >
              {card.badge}
            </span>
          </div>
          <div style={{ color: "#6b7280", fontSize: 10, lineHeight: 1.3, paddingLeft: 4 }}>
            {card.description}
          </div>
        </div>
      ))}
    </div>
  );
}
