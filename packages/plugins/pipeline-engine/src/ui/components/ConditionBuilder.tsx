import { useState, useCallback, useMemo } from "react";

const OPERATORS = [
  { value: "==", label: "equals" },
  { value: "!=", label: "not equals" },
  { value: ">", label: "greater than" },
  { value: "<", label: "less than" },
  { value: ">=", label: "greater or equal" },
  { value: "<=", label: "less or equal" },
  { value: "contains", label: "contains" },
] as const;

type Operator = (typeof OPERATORS)[number]["value"];

const OUTPUT_FIELDS = [
  { value: "status", label: "status", suggestedValues: ["approved", "rejected", "pass", "fail", "pending"] },
  { value: "decision", label: "decision", suggestedValues: ["approve", "reject", "needs_changes", "escalate"] },
  { value: "result", label: "result", suggestedValues: ["success", "failure", "partial"] },
  { value: "score", label: "score", suggestedValues: ["high", "medium", "low"] },
] as const;

function getValuesForField(field: string): string[] {
  const found = OUTPUT_FIELDS.find((f) => f.value === field);
  return found ? [...found.suggestedValues] : [];
}

interface ParsedCondition {
  stageId: string;
  field: string;
  operator: Operator;
  value: string;
}

function parseCondition(expr: string): ParsedCondition | null {
  const match = expr.match(
    /^stages\.([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_.]+)\s*(==|!=|>=|<=|>|<|contains)\s*['"](.+)['"]$/,
  );
  if (!match) return null;
  return {
    stageId: match[1],
    field: match[2],
    operator: match[3] as Operator,
    value: match[4],
  };
}

function buildExpression(parts: ParsedCondition): string {
  if (parts.operator === "contains") {
    return `stages.${parts.stageId}.output.${parts.field} contains '${parts.value}'`;
  }
  return `stages.${parts.stageId}.output.${parts.field} ${parts.operator} '${parts.value}'`;
}

export interface ConditionBuilderProps {
  value: string;
  onChange: (value: string) => void;
  stageIds: string[];
}

export function ConditionBuilder({ value, onChange, stageIds }: ConditionBuilderProps) {
  const parsed = useMemo(() => (value ? parseCondition(value) : null), [value]);
  const [isCustom, setIsCustom] = useState(!!value && !parsed);

  const [stageId, setStageId] = useState(parsed?.stageId ?? "");
  const [field, setField] = useState(parsed?.field ?? "status");
  const [operator, setOperator] = useState<Operator>(parsed?.operator ?? "==");
  const [condValue, setCondValue] = useState(parsed?.value ?? "");

  const emitChange = useCallback(
    (s: string, f: string, op: Operator, v: string) => {
      if (!s || !f || !v) {
        onChange("");
        return;
      }
      onChange(buildExpression({ stageId: s, field: f, operator: op, value: v }));
    },
    [onChange],
  );

  if (isCustom) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={modeLabelStyle}>Custom expression</span>
          <button style={toggleStyle} onClick={() => setIsCustom(false)}>
            Builder
          </button>
        </div>
        <input
          style={inputStyle}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. all(s.output.decision == 'approve' for s in stages.review.stages)"
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={modeLabelStyle}>Expression builder</span>
        <button style={toggleStyle} onClick={() => setIsCustom(true)}>
          Custom
        </button>
      </div>

      <select
        style={selectStyle}
        value={stageId}
        onChange={(e) => {
          setStageId(e.target.value);
          emitChange(e.target.value, field, operator, condValue);
        }}
      >
        <option value="">— Source stage —</option>
        {stageIds.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>

      <select
        style={selectStyle}
        value={field}
        onChange={(e) => {
          setField(e.target.value);
          setCondValue("");
          emitChange(stageId, e.target.value, operator, "");
        }}
      >
        <option value="">— Output field —</option>
        {OUTPUT_FIELDS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>

      <select
        style={selectStyle}
        value={operator}
        onChange={(e) => {
          const op = e.target.value as Operator;
          setOperator(op);
          emitChange(stageId, field, op, condValue);
        }}
      >
        {OPERATORS.map((op) => (
          <option key={op.value} value={op.value}>
            {op.label} ({op.value})
          </option>
        ))}
      </select>

      {(() => {
        const suggestions = getValuesForField(field);
        if (suggestions.length > 0) {
          return (
            <select
              style={selectStyle}
              value={condValue}
              onChange={(e) => {
                setCondValue(e.target.value);
                emitChange(stageId, field, operator, e.target.value);
              }}
            >
              <option value="">— Value —</option>
              {suggestions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          );
        }
        return (
          <input
            style={inputStyle}
            value={condValue}
            onChange={(e) => {
              setCondValue(e.target.value);
              emitChange(stageId, field, operator, e.target.value);
            }}
            placeholder="Value"
          />
        );
      })()}

      {value && (
        <div style={previewStyle}>
          <code>{value}</code>
        </div>
      )}
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

const toggleStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #4b5563",
  borderRadius: 4,
  color: "#9ca3af",
  fontSize: 10,
  padding: "2px 6px",
  cursor: "pointer",
};

const modeLabelStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const previewStyle: React.CSSProperties = {
  background: "#0f172a",
  border: "1px solid #1e293b",
  borderRadius: 4,
  padding: "4px 8px",
  fontSize: 10,
  color: "#94a3b8",
  fontFamily: "monospace",
  wordBreak: "break-all",
};
