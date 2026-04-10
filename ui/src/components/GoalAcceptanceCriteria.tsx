import { useEffect, useState } from "react";
import type { GoalAcceptanceCriterion } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";

interface Props {
  criteria: GoalAcceptanceCriterion[];
  onUpdate: (next: GoalAcceptanceCriterion[]) => void;
}

/**
 * Editable list of acceptance criteria for a goal. Each row holds its own
 * local draft state for the text input so typing does not race with server
 * round-trips; the parent is only notified on blur or Enter.
 *
 * Order is preserved by the `order` field, which we reassign on
 * add/remove/reorder to stay dense (0, 1, 2, ...).
 */

interface RowProps {
  criterion: GoalAcceptanceCriterion;
  onCommitText: (id: string, text: string) => void;
  onToggleRequired: (id: string) => void;
  onRemove: (id: string) => void;
}

function CriterionRow({
  criterion,
  onCommitText,
  onToggleRequired,
  onRemove,
}: RowProps) {
  const [draft, setDraft] = useState(criterion.text);

  // Resync local state when the upstream value changes (e.g. the parent
  // reordered criteria or the server returned an updated snapshot).
  useEffect(() => {
    setDraft(criterion.text);
  }, [criterion.text]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== criterion.text) {
      onCommitText(criterion.id, trimmed);
    } else if (!trimmed) {
      // Revert empty input to the last committed value rather than saving an
      // empty string.
      setDraft(criterion.text);
    }
  }

  return (
    <li className="flex items-start gap-2 rounded-md border border-border p-2">
      <input
        type="checkbox"
        checked={criterion.required}
        onChange={() => onToggleRequired(criterion.id)}
        className="mt-1"
        title={criterion.required ? "Required" : "Optional"}
      />
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(criterion.text);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        className="flex-1 bg-transparent text-sm outline-none"
      />
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => onRemove(criterion.id)}
        title="Remove"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

export function GoalAcceptanceCriteria({ criteria, onUpdate }: Props) {
  const [draft, setDraft] = useState("");
  const sorted = [...criteria].sort((a, b) => a.order - b.order);

  function reindex(list: GoalAcceptanceCriterion[]): GoalAcceptanceCriterion[] {
    return list.map((c, i) => ({ ...c, order: i }));
  }

  function addCriterion() {
    const text = draft.trim();
    if (!text) return;
    const next = reindex([
      ...sorted,
      { id: crypto.randomUUID(), text, required: true, order: sorted.length },
    ]);
    onUpdate(next);
    setDraft("");
  }

  function commitText(id: string, text: string) {
    const next = sorted.map((c) => (c.id === id ? { ...c, text } : c));
    onUpdate(next);
  }

  function toggleRequired(id: string) {
    const next = sorted.map((c) => (c.id === id ? { ...c, required: !c.required } : c));
    onUpdate(next);
  }

  function remove(id: string) {
    const next = reindex(sorted.filter((c) => c.id !== id));
    onUpdate(next);
  }

  return (
    <div className="space-y-2">
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No acceptance criteria yet. Add one below to define what "done" looks like for this goal.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {sorted.map((c) => (
            <CriterionRow
              key={c.id}
              criterion={c}
              onCommitText={commitText}
              onToggleRequired={toggleRequired}
              onRemove={remove}
            />
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 pt-1">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCriterion();
            }
          }}
          placeholder="Add an acceptance criterion..."
          className="flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground/40"
        />
        <Button size="sm" variant="outline" onClick={addCriterion} disabled={!draft.trim()}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add
        </Button>
      </div>
    </div>
  );
}
