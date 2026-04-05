import { useCallback, useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { Check, ChevronRight, X, Building2, Key, Bot, ListTodo, FileCheck } from "lucide-react";
import { cn } from "../lib/utils";

const STORAGE_KEY = "ironworks.gettingStarted";
const DISMISSED_KEY = "ironworks.gettingStarted.dismissed";

interface ChecklistState {
  companyCreated: boolean;
  providerConnected: boolean;
  agentCreated: boolean;
  taskAssigned: boolean;
  deliverableReviewed: boolean;
}

const DEFAULT_STATE: ChecklistState = {
  companyCreated: false,
  providerConnected: false,
  agentCreated: false,
  taskAssigned: false,
  deliverableReviewed: false,
};

function loadState(): ChecklistState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_STATE;
}

function saveState(state: ChecklistState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

const CHECKLIST_ITEMS: Array<{
  key: keyof ChecklistState;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  href?: string;
}> = [
  {
    key: "companyCreated",
    label: "Create your company",
    description: "Set up your organization for agents to work in",
    icon: Building2,
    href: "/onboarding",
  },
  {
    key: "providerConnected",
    label: "Connect an LLM provider",
    description: "Add an API key so agents can use AI models",
    icon: Key,
    href: "/company/settings",
  },
  {
    key: "agentCreated",
    label: "Create your first agent",
    description: "Hire an AI agent to start working on tasks",
    icon: Bot,
    href: "/agents/new",
  },
  {
    key: "taskAssigned",
    label: "Assign a task",
    description: "Give your agent something to work on",
    icon: ListTodo,
    href: "/issues",
  },
  {
    key: "deliverableReviewed",
    label: "Review a completed deliverable",
    description: "Check the output from your agent's work",
    icon: FileCheck,
    href: "/deliverables",
  },
];

/**
 * Mark a getting-started checklist item as complete.
 * Can be called from anywhere in the app without the component mounted.
 */
export function markGettingStartedComplete(key: keyof ChecklistState) {
  const state = loadState();
  if (state[key]) return;
  state[key] = true;
  saveState(state);
  // Dispatch a storage event so mounted checklist components update
  window.dispatchEvent(new Event("ironworks:checklist-update"));
}

interface GettingStartedChecklistProps {
  className?: string;
}

export function GettingStartedChecklist({ className }: GettingStartedChecklistProps) {
  const [state, setState] = useState<ChecklistState>(loadState);
  const [dismissed, setDismissed] = useState(isDismissed);

  // Listen for cross-component updates
  useEffect(() => {
    function onUpdate() {
      setState(loadState());
    }
    window.addEventListener("ironworks:checklist-update", onUpdate);
    window.addEventListener("storage", onUpdate);
    return () => {
      window.removeEventListener("ironworks:checklist-update", onUpdate);
      window.removeEventListener("storage", onUpdate);
    };
  }, []);

  const toggleItem = useCallback((key: keyof ChecklistState) => {
    setState((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveState(next);
      return next;
    });
  }, []);

  const completedCount = Object.values(state).filter(Boolean).length;
  const allComplete = completedCount === CHECKLIST_ITEMS.length;

  if (dismissed || allComplete) return null;

  return (
    <div className={cn("rounded-lg border border-border bg-card", className)}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h3 className="text-sm font-semibold">Getting Started</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {completedCount} of {CHECKLIST_ITEMS.length} complete
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Progress bar */}
          <div className="hidden sm:block w-24 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-500 transition-[width] duration-300"
              style={{ width: `${(completedCount / CHECKLIST_ITEMS.length) * 100}%` }}
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setDismissed(true);
              try { localStorage.setItem(DISMISSED_KEY, "true"); } catch { /* ignore */ }
            }}
            className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
            aria-label="Dismiss getting started checklist"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="divide-y divide-border">
        {CHECKLIST_ITEMS.map((item) => {
          const isComplete = state[item.key];
          const Icon = item.icon;
          return (
            <div key={item.key} className="flex items-center gap-3 px-4 py-3">
              <button
                type="button"
                onClick={() => toggleItem(item.key)}
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                  isComplete
                    ? "border-green-500 bg-green-500 text-white"
                    : "border-border hover:border-foreground/40"
                )}
                aria-label={isComplete ? `Mark "${item.label}" incomplete` : `Mark "${item.label}" complete`}
              >
                {isComplete && <Check className="h-3 w-3" />}
              </button>
              <div className="flex-1 min-w-0">
                <p className={cn("text-sm font-medium", isComplete && "line-through text-muted-foreground")}>
                  {item.label}
                </p>
                <p className="text-xs text-muted-foreground">{item.description}</p>
              </div>
              {item.href && !isComplete && (
                <Link
                  to={item.href}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronRight className="h-4 w-4" />
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
