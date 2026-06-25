import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Sparkles,
  Users,
  Target,
  ListChecks,
  MessageSquare,
  Repeat,
  Receipt,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { useNavigate, useParams } from "@/lib/router";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * First-run companion for a new tenant owner. A calm, stepped GLASSHOUSE pop-up that
 * teaches how to RUN the company: set a goal -> the Chief of Staff delegates ->
 * assigned tasks (issues) wake agents -> routines schedule recurring work -> ask the CoS.
 *
 * Gating: shows once per browser (localStorage flag) when a company context exists.
 * Reopen anywhere by dispatching `window.dispatchEvent(new Event(OPEN_COMPANION_GUIDE_EVENT))`
 * (e.g. a "Replay guide" button in Settings — see handoff).
 */
const GUIDE_SEEN_KEY = "valadrien-os.companionGuideSeenV1";
export const OPEN_COMPANION_GUIDE_EVENT = "valadrien-os:open-companion-guide";

type Step = {
  eyebrow: string;
  title: string;
  body: ReactNode;
  icon: LucideIcon;
  to?: string; // route suffix under /:companyPrefix
  toLabel?: string;
};

const Term = ({ children }: { children: ReactNode }) => (
  <strong className="font-medium text-foreground">{children}</strong>
);

const STEPS: Step[] = [
  {
    eyebrow: "Welcome",
    icon: Sparkles,
    title: "Your company runs itself — watch it happen.",
    body: (
      <>
        This is a live control room. Your AI team takes tasks, executes, and reports in real
        time. When the screen moves, the company moved.
      </>
    ),
  },
  {
    eyebrow: "Your team",
    icon: Users,
    title: "Meet the team running it.",
    body: (
      <>
        A <Term>Chief of Staff</Term> orchestrates; specialists own each lane — revenue,
        delivery, success, marketing. Each has a face and a role.
      </>
    ),
    to: "/org",
    toLabel: "Open Org",
  },
  {
    eyebrow: "Direction",
    icon: Target,
    title: "Set the goal. Your Chief of Staff delegates.",
    body: (
      <>
        Give the company a goal in <Term>Goals</Term>. Your Chief of Staff breaks it into
        sub-goals and hands each to the right teammate.
      </>
    ),
    to: "/goals",
    toLabel: "Open Goals",
  },
  {
    eyebrow: "Execution",
    icon: ListChecks,
    title: "Work runs on tasks, not wishes.",
    body: (
      <>
        An agent starts the moment it's assigned a task. Create one in <Term>Issues</Term>,
        assign it to a teammate, and they wake up and execute — you watch it in the thread.
      </>
    ),
    to: "/issues",
    toLabel: "Open Issues",
  },
  {
    eyebrow: "Delegate",
    icon: MessageSquare,
    title: "Just ask your Chief of Staff.",
    body: (
      <>
        Don't micromanage. In <Term>Issues</Term>, assign a task to your Chief of Staff and
        tell it what you want — &ldquo;set up weekly reporting&rdquo;, &ldquo;find ten
        leads&rdquo;. It plans, delegates, and reports back.
      </>
    ),
    to: "/issues",
    toLabel: "Open Issues",
  },
  {
    eyebrow: "On a schedule",
    icon: Repeat,
    title: "Make the work recur.",
    body: (
      <>
        Turn anything repeating into a <Term>Routine</Term> — daily reports, weekly outreach,
        monthly reviews. Build one yourself, or ask your Chief of Staff to set it up.
      </>
    ),
    to: "/routines",
    toLabel: "Open Routines",
  },
  {
    eyebrow: "You're set",
    icon: Receipt,
    title: "Watch the meter, then let them run.",
    body: (
      <>
        Every action costs; track spend in <Term>Costs</Term>. That's the whole job — set a
        goal, assign tasks, and let your team run the company. You can replay this guide from
        Settings.
      </>
    ),
    to: "/costs",
    toLabel: "Open Costs",
  },
];

export function CompanionGuide() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  const params = useParams() as { companyPrefix?: string };
  const companyPrefix = params.companyPrefix;

  // Auto-open once for a new owner, only inside a company context.
  useEffect(() => {
    if (!companyPrefix) return;
    let seen = false;
    try {
      seen = localStorage.getItem(GUIDE_SEEN_KEY) === "true";
    } catch {
      /* localStorage unavailable — show the guide rather than suppress it */
    }
    if (seen) return;
    const t = setTimeout(() => setOpen(true), 600);
    return () => clearTimeout(t);
  }, [companyPrefix]);

  // Allow replaying from elsewhere (e.g. a Settings button).
  useEffect(() => {
    const reopen = () => {
      setStep(0);
      setOpen(true);
    };
    window.addEventListener(OPEN_COMPANION_GUIDE_EVENT, reopen);
    return () => window.removeEventListener(OPEN_COMPANION_GUIDE_EVENT, reopen);
  }, []);

  const markSeen = useCallback(() => {
    try {
      localStorage.setItem(GUIDE_SEEN_KEY, "true");
    } catch {
      /* ignore */
    }
  }, []);

  const close = useCallback(() => {
    markSeen();
    setOpen(false);
  }, [markSeen]);

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const Icon = current.icon;

  const goTo = useCallback(() => {
    markSeen();
    setOpen(false);
    if (current.to && companyPrefix) navigate(`/${companyPrefix}${current.to}`);
  }, [current.to, companyPrefix, markSeen, navigate]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="overflow-hidden rounded-none border-border bg-card p-0 sm:max-w-xl"
      >
        <div className="flex">
          {/* static Sodium rail — a calm signal, not motion (GLASSHOUSE) */}
          <div aria-hidden className="w-[2px] shrink-0 bg-primary/70" />
          <div className="flex-1 p-6 sm:p-7">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-primary">
                {current.eyebrow}
              </span>
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {String(step + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")}
              </span>
            </div>

            <div className="mt-5 flex size-10 items-center justify-center rounded-[2px] border border-border bg-background text-primary">
              <Icon className="size-5" strokeWidth={1.75} />
            </div>

            <DialogTitle className="mt-4 text-left font-serif text-2xl font-medium leading-snug tracking-[-0.01em] text-foreground">
              {current.title}
            </DialogTitle>

            <DialogDescription className="mt-3 text-left text-sm leading-relaxed text-muted-foreground">
              {current.body}
            </DialogDescription>

            {current.to && (
              <button
                type="button"
                onClick={goTo}
                className="mt-4 inline-flex items-center gap-1.5 font-mono text-[12px] uppercase tracking-[0.12em] text-primary transition-opacity hover:opacity-80"
              >
                {current.toLabel}
                <ArrowRight className="size-3.5" />
              </button>
            )}

            <div className="mt-6 flex items-center gap-1.5" aria-hidden>
              {STEPS.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1 rounded-full transition-all",
                    i === step ? "w-5 bg-primary" : "w-1.5 bg-border",
                  )}
                />
              ))}
            </div>

            <div className="mt-6 flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={close}
                className="text-muted-foreground"
              >
                Skip tour
              </Button>
              <div className="flex items-center gap-2">
                {step > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setStep((s) => s - 1)}>
                    Back
                  </Button>
                )}
                {isLast ? (
                  <Button size="sm" onClick={close}>
                    Done
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => setStep((s) => Math.min(s + 1, STEPS.length - 1))}
                  >
                    Next
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
