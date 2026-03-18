"use client";

import { useState, useEffect, useCallback } from "react";

type PaletteColor = {
  role: string;
  hex: string;
  hsl: { h: number; s: number; l: number };
};

type PaletteOption = {
  id: string;
  name: string;
  colors: PaletteColor[];
};

type Props = {
  questionnaireId: string;
  onComplete: () => void;
};

const ROLE_LABELS: Record<string, string> = {
  primary: "Primary",
  secondary: "Secondary",
  accent: "Accent",
  background: "Background",
  text: "Text",
};

export function StepPalette({ questionnaireId, onComplete }: Props) {
  const [palettes, setPalettes] = useState<PaletteOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function generate() {
      try {
        const res = await fetch("/api/generate/palette", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionnaireId }),
        });
        if (!res.ok) throw new Error("Failed to generate palettes");
        const data = await res.json();
        setPalettes(data.palettes);
      } catch {
        setError("Could not generate palettes. Please try again.");
      } finally {
        setLoading(false);
      }
    }
    generate();
  }, [questionnaireId]);

  const handleSelect = useCallback(
    async (paletteId: string) => {
      setSelectedId(paletteId);
      setSaving(true);
      try {
        const res = await fetch("/api/palette/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paletteId, questionnaireId }),
        });
        if (!res.ok) throw new Error("Failed to save selection");
      } catch {
        setError("Could not save selection.");
      } finally {
        setSaving(false);
      }
    },
    [questionnaireId]
  );

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-violet-200 border-t-violet-600" />
        <p className="mt-4 text-sm text-gray-500">Generating your color palettes...</p>
      </div>
    );
  }

  if (error && palettes.length === 0) {
    return (
      <div className="rounded-lg bg-red-50 p-6 text-center">
        <p className="text-sm text-red-700">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900">Choose your color palette</h3>
        <p className="mt-1 text-sm text-gray-500">
          We generated these palettes based on your industry and brand personality.
          Pick the one that feels right.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {palettes.map((palette) => {
          const isSelected = selectedId === palette.id;
          return (
            <button
              key={palette.id}
              type="button"
              onClick={() => handleSelect(palette.id)}
              className={`group rounded-xl border-2 p-4 text-left transition-all ${
                isSelected
                  ? "border-violet-600 ring-2 ring-violet-200"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-900">
                  {palette.name}
                </span>
                {isSelected && (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
                    Selected
                  </span>
                )}
              </div>

              {/* Color swatches row */}
              <div className="flex gap-1 overflow-hidden rounded-lg">
                {palette.colors
                  .filter((c) => c.role !== "background" && c.role !== "text")
                  .map((c) => (
                    <div
                      key={c.role}
                      className="h-16 flex-1"
                      style={{ backgroundColor: c.hex }}
                      title={`${ROLE_LABELS[c.role] ?? c.role}: ${c.hex}`}
                    />
                  ))}
              </div>

              {/* Full palette detail */}
              <div className="mt-3 flex flex-wrap gap-2">
                {palette.colors.map((c) => (
                  <div key={c.role} className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-4 w-4 rounded-full border border-gray-200"
                      style={{ backgroundColor: c.hex }}
                    />
                    <span className="text-xs text-gray-500">
                      {ROLE_LABELS[c.role] ?? c.role}
                    </span>
                    <span className="font-mono text-xs text-gray-400">
                      {c.hex}
                    </span>
                  </div>
                ))}
              </div>

              {/* Preview: text on background */}
              {(() => {
                const bg = palette.colors.find((c) => c.role === "background");
                const txt = palette.colors.find((c) => c.role === "text");
                const primary = palette.colors.find((c) => c.role === "primary");
                if (!bg || !txt || !primary) return null;
                return (
                  <div
                    className="mt-3 rounded-md px-3 py-2"
                    style={{ backgroundColor: bg.hex }}
                  >
                    <p className="text-sm font-semibold" style={{ color: primary.hex }}>
                      Brand Name
                    </p>
                    <p className="text-xs" style={{ color: txt.hex }}>
                      Sample body text for preview
                    </p>
                  </div>
                );
              })()}
            </button>
          );
        })}
      </div>

      {selectedId && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onComplete}
            disabled={saving}
            className="rounded-lg bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Continue with this palette"}
          </button>
        </div>
      )}
    </div>
  );
}
