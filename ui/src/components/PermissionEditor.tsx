import { PERMISSION_KEYS } from "@paperclipai/shared";
import type { PermissionKey } from "@paperclipai/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/* ---- Metadata ---- */

export const PERMISSION_KEY_LABELS: Record<PermissionKey, string> = {
  "agents:create": "Create agents",
  "users:invite": "Invite users",
  "users:manage_permissions": "Manage permissions",
  "tasks:assign": "Assign tasks",
  "tasks:assign_scope": "Set assignment scope",
  "joins:approve": "Approve join requests",
};

// Group display names keyed by the prefix before the colon
const GROUP_LABELS: Record<string, string> = {
  agents: "Agents",
  users: "Users",
  tasks: "Tasks",
  joins: "Joins",
};

interface PermissionGroup {
  groupKey: string;
  label: string;
  keys: PermissionKey[];
}

// Derive stable group order from PERMISSION_KEYS so new keys stay in sync automatically
function buildGroups(): PermissionGroup[] {
  const seen: Record<string, PermissionKey[]> = {};
  const order: string[] = [];

  for (const key of PERMISSION_KEYS) {
    const prefix = key.split(":")[0];
    if (!seen[prefix]) {
      seen[prefix] = [];
      order.push(prefix);
    }
    seen[prefix].push(key);
  }

  return order.map((prefix) => ({
    groupKey: prefix,
    label: GROUP_LABELS[prefix] ?? prefix,
    keys: seen[prefix],
  }));
}

const PERMISSION_GROUPS = buildGroups();

/* ---- Props ---- */

export interface PermissionEditorProps {
  /**
   * The set of currently-granted permission keys.
   */
  grants: PermissionKey[];

  /**
   * Called with the full next set of grants whenever any checkbox changes.
   * The parent is responsible for persisting the change (e.g. calling a mutation).
   */
  onChange: (nextGrants: PermissionKey[]) => void;

  /**
   * When true the editor is visually dimmed and all checkboxes are disabled.
   * Pass `mutation.isPending` here to block interaction during saves.
   */
  isPending?: boolean;

  /**
   * Additional class names applied to the outermost container.
   */
  className?: string;
}

/* ---- Component ---- */

/**
 * PermissionEditor — a compact, grouped, checkbox-based permissions UI.
 *
 * Works for any principal that holds PermissionKey grants (agents, users).
 * Renders a bordered section with category sub-headers and a responsive
 * 1→2→3 column grid that collapses to a single column on mobile.
 */
export function PermissionEditor({
  grants,
  onChange,
  isPending = false,
  className,
}: PermissionEditorProps) {
  function toggle(key: PermissionKey) {
    const has = grants.includes(key);
    const next = has ? grants.filter((k) => k !== key) : [...grants, key];
    onChange(next);
  }

  return (
    <div
      className={cn(
        "border border-border rounded-lg overflow-hidden",
        isPending && "opacity-60 pointer-events-none",
        className
      )}
    >
      {PERMISSION_GROUPS.map((group, gi) => (
        <div
          key={group.groupKey}
          className={cn(gi > 0 && "border-t border-border")}
        >
          {/* Group header */}
          <div className="px-4 py-2 bg-muted/40">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {group.label}
            </span>
          </div>

          {/* Permission checkboxes — responsive grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 px-4 py-3 gap-x-4 gap-y-3">
            {group.keys.map((key) => {
              const checked = grants.includes(key);
              const id = `perm-${key}`;

              return (
                <div key={key} className="flex items-center gap-2.5 min-w-0">
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={() => toggle(key)}
                    disabled={isPending}
                    aria-label={PERMISSION_KEY_LABELS[key]}
                  />
                  <Label
                    htmlFor={id}
                    className="text-sm font-normal leading-none cursor-pointer truncate"
                  >
                    {PERMISSION_KEY_LABELS[key]}
                  </Label>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
