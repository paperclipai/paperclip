import { useState, useEffect } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard,
  CircleDot,
  Bot,
  BookText,
  DollarSign,
  X,
  Sparkles,
} from "lucide-react";

const STEPS = [
  {
    icon: LayoutDashboard,
    title: "War Room",
    description: "Your command center -- live agents, active issues, and cost overview at a glance.",
    link: "/dashboard",
  },
  {
    icon: CircleDot,
    title: "Issues",
    description: "Track work for both humans and AI agents. Create, assign, and monitor progress.",
    link: "/issues",
  },
  {
    icon: Bot,
    title: "Agents",
    description: "Your AI workforce. Hire agents, assign tasks, and review their output.",
    link: "/agents/all",
  },
  {
    icon: BookText,
    title: "Knowledge Base",
    description: "Shared documentation that agents and humans reference for context.",
    link: "/knowledge",
  },
  {
    icon: DollarSign,
    title: "Costs",
    description: "Monitor spending per agent, project, and provider. Set budget caps to stay in control.",
    link: "/costs",
  },
];

function getStorageKey(userId: string): string {
  return `ironworks:welcome-dismissed:${userId}`;
}

export function WelcomeBanner() {
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const userId = sessionQuery.data?.user?.id;
  const [dismissed, setDismissed] = useState(true); // Start dismissed to avoid flash

  useEffect(() => {
    if (!userId) return;
    const key = getStorageKey(userId);
    const stored = localStorage.getItem(key);
    setDismissed(stored === "true");
  }, [userId]);

  function handleDismiss() {
    if (!userId) return;
    localStorage.setItem(getStorageKey(userId), "true");
    setDismissed(true);
  }

  if (dismissed || !userId) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-5 relative">
      <button
        type="button"
        onClick={handleDismiss}
        className="absolute top-3 right-3 text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Dismiss welcome guide"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="h-4 w-4 text-amber-500" />
        <h2 className="text-sm font-semibold">Welcome to IronWorks</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Here is a quick overview of the key areas. Click any card to explore.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {STEPS.map((step) => (
          <Link
            key={step.title}
            to={step.link}
            className="group rounded-md border border-border p-3 hover:border-foreground/30 hover:bg-accent/30 transition-colors"
          >
            <step.icon className="h-4 w-4 text-muted-foreground group-hover:text-foreground mb-2 transition-colors" />
            <div className="text-xs font-medium">{step.title}</div>
            <div className="text-[11px] text-muted-foreground leading-relaxed mt-1">
              {step.description}
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-3 flex justify-end">
        <Button variant="ghost" size="sm" onClick={handleDismiss} className="text-xs">
          Got it, dismiss
        </Button>
      </div>
    </div>
  );
}
