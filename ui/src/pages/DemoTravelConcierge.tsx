import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { companyTemplatesApi } from "../api/companyTemplates";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Loader2, Rocket, Sparkles, CheckCircle2, Bot, Building2, ListTodo, Compass, Star, Clock, ArrowUpRight } from "lucide-react";
import { usePageMeta } from "../hooks/usePageMeta";

// ─── Agent profile data ──────────────────────────────────────────────────────

interface AgentProfile {
  name: string;
  role: string;
  title: string;
  emoji: string;
  color: string;
  description: string;
  skills: string[];
}

const AGENTS: AgentProfile[] = [
  {
    name: "Atlas",
    role: "ceo",
    title: "CEO & Head Concierge",
    emoji: "🧭",
    color: "from-teal-500 to-emerald-600",
    description:
      "Owns client relationships end-to-end. Delegates booking research and itinerary planning, monitors traveler satisfaction, and escalates edge cases.",
    skills: ["Task Planning", "Strategy", "Client Management"],
  },
  {
    name: "Lyra",
    role: "general",
    title: "Travel Booking Agent",
    emoji: "🔍",
    color: "from-sky-500 to-blue-600",
    description:
      "Researches flights, hotels, and ground transport. Compares options across carriers, drafts itineraries with price breakdowns, and flags restrictive fare rules.",
    skills: ["Browser Research", "Price Comparison", "Itinerary Building"],
  },
  {
    name: "Sage",
    role: "general",
    title: "Traveler Support Agent",
    emoji: "🛟",
    color: "from-amber-500 to-orange-600",
    description:
      "Handles pre-trip questions, disruptions, and post-trip feedback. Proactively offers rebooking options for delays over 2 hours and escalates safety-critical situations.",
    skills: ["Issue Triage", "Customer Support", "Disruption Management"],
  },
];

// ─── Walkthrough steps ───────────────────────────────────────────────────────

interface WalkthroughStep {
  number: number;
  icon: React.ReactNode;
  title: string;
  description: string;
  action: { label: string; href: string };
}

// ─── Page component ──────────────────────────────────────────────────────────

export function DemoTravelConcierge() {
  usePageMeta("Demo: Travel Concierge", "Demo: AI-powered travel concierge experience.");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [deployed, setDeployed] = useState<{
    companyId: string;
    companyName: string;
    issuePrefix: string;
  } | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const { data: templates } = useQuery({
    queryKey: queryKeys.companyTemplates.list,
    queryFn: () => companyTemplatesApi.list(),
  });

  const travelTemplate = templates?.find((t) => t.key === "travel-concierge");

  const deployMutation = useMutation({
    mutationFn: () =>
      companyTemplatesApi.deploy("travel-concierge"),
    onSuccess: (result) => {
      setDeployed({
        companyId: result.company.id,
        companyName: result.company.name,
        issuePrefix: result.company.issuePrefix,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
    onError: (err: Error) => {
      setDeployError(err.message);
    },
  });

  // Scroll to top on mount
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  function handleDeploy() {
    if (!session) {
      navigate("/auth?next=/demo/travel-concierge");
      return;
    }
    setDeployError(null);
    deployMutation.mutate();
  }

  // ── Post-deploy walkthrough steps ──────────────────────────────────────

  const walkthroughSteps: WalkthroughStep[] = deployed
    ? [
        {
          number: 1,
          icon: <Bot className="h-5 w-5" />,
          title: "Meet your AI team",
          description:
            "Your company has 3 pre-configured agents: Atlas (CEO), Lyra (Booking Agent), and Sage (Support Agent). Each has tailored instructions and skills.",
          action: {
            label: "View Agents",
            href: `/${deployed.issuePrefix}/agents`,
          },
        },
        {
          number: 2,
          icon: <ListTodo className="h-5 w-5" />,
          title: "Review your first task",
          description:
            `A starter task "${"Stand up the booking intake workflow"}" is ready and assigned to your CEO. This gets your concierge service operational.`,
          action: {
            label: "Open Task",
            href: `/${deployed.issuePrefix}/issues`,
          },
        },
        {
          number: 3,
          icon: <Compass className="h-5 w-5" />,
          title: "Watch them work",
          description:
            "Go to your dashboard to see real-time activity as your agents begin planning, researching, and executing their first assignments.",
          action: {
            label: "Open Dashboard",
            href: `/${deployed.issuePrefix}/dashboard`,
          },
        },
      ]
    : [];

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      {/* ── Top bar ──────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            <span className="text-sm font-semibold">Paperclip</span>
          </div>
          <div className="flex items-center gap-3">
            {session ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/company/templates")}
              >
                All Templates
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate("/auth?next=/demo/travel-concierge")}
              >
                Sign In
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-12 sm:py-20">
        {/* ── Hero section ───────────────────────────────────────────── */}
        <section className="mb-20 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-xs font-medium text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            Demo — 10 minute setup
          </div>
          <h1 className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Create Your AI
            <br />
            <span className="bg-gradient-to-r from-teal-500 to-sky-500 bg-clip-text text-transparent">
              Travel Concierge
            </span>
          </h1>
          <p className="mx-auto mb-8 max-w-2xl text-lg text-muted-foreground">
            Deploy a fully operational travel concierge company with AI agents
            that handle bookings, itineraries, and traveler support. No setup
            required — just one click.
          </p>

          <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <Button
              size="lg"
              onClick={handleDeploy}
              disabled={deployMutation.isPending}
              className="h-12 min-w-[240px] text-base shadow-lg"
            >
              {deployMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Deploying your concierge...
                </>
              ) : (
                <>
                  <Rocket className="mr-2 h-5 w-5" />
                  Deploy Your Travel Concierge
                </>
              )}
            </Button>
            {!session && (
              <p className="text-xs text-muted-foreground">
                You'll be prompted to sign in or create an account.
              </p>
            )}
          </div>

          {deployError && (
            <div className="mx-auto mt-4 max-w-md rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {deployError}
            </div>
          )}
        </section>

        {/* ── Post-deploy walkthrough ───────────────────────────────── */}
        {deployed && (
          <section className="mb-20">
            <div className="mx-auto max-w-3xl">
              <div className="mb-8 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-center">
                <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-500" />
                <h2 className="text-2xl font-bold">
                  {deployed.companyName} is Live!
                </h2>
                <p className="mt-1 text-muted-foreground">
                  Your AI travel concierge company is deployed and ready. Here's
                  your 3-step guide to get started.
                </p>
              </div>

              <div className="space-y-4">
                {walkthroughSteps.map((step) => (
                  <Card
                    key={step.number}
                    className="border-border/60 transition-shadow hover:shadow-md"
                  >
                    <CardHeader className="flex flex-row items-start gap-4 pb-2">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                        {step.icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <CardTitle className="text-base">
                          Step {step.number}: {step.title}
                        </CardTitle>
                        <CardDescription className="mt-1">
                          {step.description}
                        </CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent className="pb-4">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigate(step.action.href)}
                      >
                        {step.action.label}
                        <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ── Meet Your AI Team ──────────────────────────────────────── */}
        <section className="mb-20">
          <div className="mb-10 text-center">
            <h2 className="text-2xl font-bold sm:text-3xl">
              Meet Your AI Team
            </h2>
            <p className="mt-2 text-muted-foreground">
              Three pre-configured agents, each with specialized skills and
              instructions.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-3">
            {AGENTS.map((agent) => (
              <Card
                key={agent.name}
                className="group border-border/60 transition-all hover:shadow-md"
              >
                <CardHeader>
                  <div className="mb-2 flex items-center gap-3">
                    <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br text-2xl shadow-sm">
                      {agent.emoji}
                    </span>
                    <div>
                      <CardTitle className="text-base">{agent.name}</CardTitle>
                      <p className="text-xs text-muted-foreground">
                        {agent.title}
                      </p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {agent.description}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {agent.skills.map((skill) => (
                      <span
                        key={skill}
                        className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* ── How It Works ─────────────────────────────────────────────── */}
        <section className="mb-20">
          <div className="mb-10 text-center">
            <h2 className="text-2xl font-bold sm:text-3xl">
              How It Works
            </h2>
            <p className="mt-2 text-muted-foreground">
              Three simple steps to a working AI travel concierge.
            </p>
          </div>

          <div className="grid gap-8 sm:grid-cols-3">
            {[
              {
                icon: <Rocket className="h-6 w-6" />,
                title: "1. Deploy",
                description:
                  "Click the button above. We create a new company with your travel concierge, agents, skills, knowledge base, and a starter task.",
              },
              {
                icon: <Bot className="h-6 w-6" />,
                title: "2. Meet Your Agents",
                description:
                  "Atlas, Lyra, and Sage are ready to go. Each has pre-written instructions and the right skills for their role.",
              },
              {
                icon: <ListTodo className="h-6 w-6" />,
                title: "3. Assign Their First Task",
                description:
                  "A starter task is already queued. Watch your agents plan, research, and execute — all within the Paperclip board.",
              },
            ].map((step, i) => (
              <div key={i} className="text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  {step.icon}
                </div>
                <h3 className="mb-2 text-lg font-semibold">{step.title}</h3>
                <p className="text-sm text-muted-foreground">
                  {step.description}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── What You Get ──────────────────────────────────────────────── */}
        <section>
          <div className="mb-10 text-center">
            <h2 className="text-2xl font-bold sm:text-3xl">
              What You Get
            </h2>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: <Building2 className="h-5 w-5" />,
                title: "Travel Company",
                description:
                  "A fully configured company with travel concierge branding and profile.",
              },
              {
                icon: <Bot className="h-5 w-5" />,
                title: "3 AI Agents",
                description:
                  "CEO, Booking Agent, and Support Agent — each with role-specific instructions.",
              },
              {
                icon: <Star className="h-5 w-5" />,
                title: "Travel Skills",
                description:
                  "Task planning, browser research, and issue triage skills installed and ready.",
              },
              {
                icon: <Clock className="h-5 w-5" />,
                title: "Starter Task",
                description:
                  "A pre-built first task gets your team working immediately.",
              },
            ].map((item, i) => (
              <Card
                key={i}
                className="border-border/60 text-center transition-shadow hover:shadow-sm"
              >
                <CardHeader>
                  <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    {item.icon}
                  </div>
                  <CardTitle className="text-sm">{item.title}</CardTitle>
                  <CardDescription className="text-xs">
                    {item.description}
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <footer className="mt-20 border-t border-border/40 pt-8 text-center text-sm text-muted-foreground">
          <p>
            Built on{" "}
            <a
              href="https://github.com/paperclipai/paperclip"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Paperclip
            </a>{" "}
            — the open-source control plane for AI agent companies.
          </p>
        </footer>
      </main>
    </div>
  );
}