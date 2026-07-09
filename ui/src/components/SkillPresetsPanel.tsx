import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SkillPreset {
  id: string;
  name: string;
  skillKeys: string[];
}

interface SkillPresetsPanelProps {
  companyId: string;
  skillDraft: string[];
  availableSkillKeys: string[];
  onApply: (skillKeys: string[]) => void;
  disabled?: boolean;
}

function getStorageKey(companyId: string) {
  return `paperclip-skill-presets-${companyId}`;
}

function loadPresets(companyId: string): SkillPreset[] {
  try {
    const raw = localStorage.getItem(getStorageKey(companyId));
    if (!raw) return [];
    return JSON.parse(raw) as SkillPreset[];
  } catch {
    return [];
  }
}

function savePresets(companyId: string, presets: SkillPreset[]) {
  localStorage.setItem(getStorageKey(companyId), JSON.stringify(presets));
}

export function SkillPresetsPanel({
  companyId,
  skillDraft,
  availableSkillKeys: _availableSkillKeys,
  onApply,
  disabled,
}: SkillPresetsPanelProps) {
  const [presets, setPresets] = useState<SkillPreset[]>(() => loadPresets(companyId));
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [newPresetName, setNewPresetName] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPresets(loadPresets(companyId));
  }, [companyId]);

  useEffect(() => {
    if (showSaveDialog) {
      setTimeout(() => nameInputRef.current?.focus(), 0);
    }
  }, [showSaveDialog]);

  function handlePresetToggle(preset: SkillPreset, checked: boolean) {
    if (disabled) return;
    if (checked) {
      onApply(Array.from(new Set([...skillDraft, ...preset.skillKeys])));
    } else {
      onApply(skillDraft.filter((k) => !preset.skillKeys.includes(k)));
    }
  }

  function handleSavePreset() {
    const name = newPresetName.trim();
    if (!name) return;
    const preset: SkillPreset = {
      id: crypto.randomUUID(),
      name,
      skillKeys: [...skillDraft],
    };
    const next = [...presets, preset];
    setPresets(next);
    savePresets(companyId, next);
    setNewPresetName("");
    setShowSaveDialog(false);
  }

  function handleDeletePreset(id: string) {
    if (pendingDeleteId === id) {
      const next = presets.filter((p) => p.id !== id);
      setPresets(next);
      savePresets(companyId, next);
      setPendingDeleteId(null);
    } else {
      setPendingDeleteId(id);
    }
  }

  return (
    <section className="border-y border-border">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">Skill presets</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={disabled || skillDraft.length === 0}
          onClick={() => {
            setShowSaveDialog(true);
            setNewPresetName("");
          }}
        >
          Save as preset
        </Button>
      </div>

      {showSaveDialog && (
        <div className="border-b border-border bg-muted/20 px-3 py-3">
          <p className="mb-2 text-xs text-muted-foreground">
            Saving {skillDraft.length} selected skill{skillDraft.length !== 1 ? "s" : ""} as a preset.
          </p>
          <div className="flex items-center gap-2">
            <Input
              ref={nameInputRef}
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              placeholder="Preset name"
              className="h-7 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSavePreset();
                if (e.key === "Escape") setShowSaveDialog(false);
              }}
            />
            <Button size="sm" className="h-7 px-3 text-xs" onClick={handleSavePreset} disabled={!newPresetName.trim()}>
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => setShowSaveDialog(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {presets.length === 0 ? (
        <div className="px-3 py-4 text-sm text-muted-foreground">
          No presets yet. Save your current skill selection to create one.
        </div>
      ) : (
        presets.map((preset) => {
          const allIncluded = preset.skillKeys.every((k) => skillDraft.includes(k));
          const isConfirmingDelete = pendingDeleteId === preset.id;
          return (
            <div
              key={preset.id}
              className="flex items-start gap-3 border-b border-border px-3 py-3 text-sm last:border-b-0 hover:bg-accent/20"
            >
              <input
                type="checkbox"
                checked={allIncluded}
                disabled={disabled}
                onChange={(e) => handlePresetToggle(preset, e.target.checked)}
                className="mt-0.5 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <div className="min-w-0 flex-1">
                <span className="font-medium">{preset.name}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  ({preset.skillKeys.length} skill{preset.skillKeys.length !== 1 ? "s" : ""})
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {isConfirmingDelete ? (
                  <>
                    <span className="text-xs text-muted-foreground">Delete?</span>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => handleDeletePreset(preset.id)}
                    >
                      Yes
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => setPendingDeleteId(null)}
                    >
                      No
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => handleDeletePreset(preset.id)}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
