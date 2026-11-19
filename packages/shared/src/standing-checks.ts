import { z } from "zod";

/**
 * Standing checks (experimental, `enableResponsibilities`): an instruction an
 * agent carries out each time its heartbeat timer wakes it, without a task
 * being created per wake-up. A standing check is a routine whose only trigger
 * is of kind `heartbeat`; that trigger never fires a run. Instead the agent's
 * timer wake lists its active standing checks, and the agent reports what it
 * found for each through `POST /api/routines/:id/standing-check-results`.
 */

export const STANDING_CHECK_OUTCOMES = ["nothing_needed", "acted"] as const;
export type StandingCheckOutcome = (typeof STANDING_CHECK_OUTCOMES)[number];

export const STANDING_CHECK_OUTCOME_LABEL: Record<StandingCheckOutcome, string> = {
  nothing_needed: "Nothing needed",
  acted: "Acted",
};

/** Body an agent sends after carrying out one standing check on a wake-up. */
export const reportStandingCheckSchema = z
  .object({
    outcome: z.enum(STANDING_CHECK_OUTCOMES),
    /** One plain sentence: what it found, and what it did. Required when it acted. */
    note: z.string().trim().min(1).max(1000).optional().nullable(),
    /** A task the agent created or updated because of what it found. */
    issueId: z.string().uuid().optional().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome === "acted" && !value.note) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Say in note what you found and what you did" });
    }
  });
export type ReportStandingCheck = z.infer<typeof reportStandingCheckSchema>;

/** What `POST /api/routines/:id/standing-check-results` returns. */
export interface StandingCheckReported {
  routineId: string;
  runId: string;
  checkedAt: string;
  outcome: StandingCheckOutcome;
  note: string | null;
  issueId: string | null;
}
