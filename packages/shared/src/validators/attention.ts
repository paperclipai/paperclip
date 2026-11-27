import { z } from "zod";
import { ATTENTION_CLOSE_MODES } from "../types/attention.js";

const reasonSchema = z.string().trim().max(4000).nullish();

/**
 * Body of the attention close endpoint (PAP-749 plan §2, Rule 6). Snooze needs
 * a future `until`; the other modes must not send one. The fingerprint is
 * personal presentation state only, so a wrong value just lets the card return.
 */
export const attentionCloseSchema = z.object({
  mode: z.enum(ATTENTION_CLOSE_MODES),
  reason: reasonSchema,
  until: z.string().trim().datetime({ offset: true }).nullish(),
  fingerprint: z.string().trim().min(1).max(200).nullish(),
}).strict().superRefine((value, ctx) => {
  if (value.mode !== "snooze") {
    if (value.until != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["until"], message: "Only snooze takes an until time" });
    }
    if (value.mode === "withdraw" && value.fingerprint != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fingerprint"], message: "Withdraw does not take a fingerprint" });
    }
    return;
  }
  if (value.until == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["until"], message: "Snooze requires until" });
    return;
  }
  if (new Date(value.until).getTime() <= Date.now()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["until"], message: "until must be in the future" });
  }
});

export type AttentionClose = z.infer<typeof attentionCloseSchema>;

/** Body of the attention transfer endpoint ("Route to @x"). */
export const attentionTransferSchema = z.object({
  userId: z.string().trim().min(1).max(200),
  reason: reasonSchema,
}).strict();

export type AttentionTransfer = z.infer<typeof attentionTransferSchema>;
