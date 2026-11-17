import type { AgentAssignmentProfile } from "@paperclipai/shared";
import { NativeSelect } from "@/components/ui/select";
import { parseCapabilityTags } from "../lib/agent-assignment";
import { DraftInput, ToggleField } from "./agent-config-primitives";

export const AUTO_ASSIGNMENT_HELP =
  "Lets Paperclip pick this agent for unassigned tasks when you click Auto-assign. Tasks that need a capability go only to agents that list it.";

const QUALITY_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "1", label: "1 (light)" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4", label: "4" },
  { value: "5", label: "5 (strongest)" },
];

export function AgentAutoAssignmentFields({
  value,
  onChange,
}: {
  value: AgentAssignmentProfile;
  onChange: (next: AgentAssignmentProfile) => void;
}) {
  return (
    <div className="space-y-2" data-testid="auto-assignment-fields">
      <ToggleField
        label="Automatic assignment"
        checked={value.enabled}
        onChange={(enabled) => onChange({ ...value, enabled })}
      />
      <p className="text-xs text-muted-foreground">{AUTO_ASSIGNMENT_HELP}</p>
      {value.enabled && (
        <>
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-xs text-muted-foreground">Capabilities</span>
            <DraftInput
              aria-label="Capabilities"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground/40"
              placeholder="frontend, sql, docs"
              value={value.capabilities.join(", ")}
              onCommit={(text) => onChange({ ...value, capabilities: parseCapabilityTags(text) })}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-xs text-muted-foreground">Quality</span>
            <NativeSelect
              aria-label="Quality"
              value={value.quality === undefined ? "" : String(value.quality)}
              onChange={(event) => {
                const { quality: _previous, ...rest } = value;
                onChange(event.target.value ? { ...rest, quality: Number(event.target.value) } : rest);
              }}
            >
              {QUALITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </NativeSelect>
          </div>
        </>
      )}
    </div>
  );
}
