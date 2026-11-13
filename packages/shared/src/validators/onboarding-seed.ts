import { z } from "zod";

/**
 * The onboarding seed Paperclip Cloud pushes into a stack at activation
 * Every field except `revision` is customer free text collected in
 * the Cloud signup wizard, so it is untrusted input and is bounded here to the
 * same limits Cloud enforces before sending.
 *
 * The seed rides the JSON body only. The `x-paperclip-cloud-*` headers are the
 * trusted identity envelope — every member is derived server-side from host +
 * verified domain records — and must never be read for seed content.
 */
export const MISSION_MAX_LENGTH = 2000;
export const AGENT_NAME_MAX_LENGTH = 80;
export const AGENT_ROLE_MAX_LENGTH = 120;
export const FIRST_TASK_TITLE_MAX_LENGTH = 200;
export const FIRST_TASK_DETAILS_MAX_LENGTH = 2000;

export const applyOnboardingSeedSchema = z.object({
  revision: z.string().min(1).max(128),
  mission: z.string().max(MISSION_MAX_LENGTH).optional(),
  agent: z
    .object({
      name: z.string().min(1).max(AGENT_NAME_MAX_LENGTH),
      role: z.string().max(AGENT_ROLE_MAX_LENGTH).optional(),
    })
    .optional(),
  firstTask: z
    .object({
      title: z.string().min(1).max(FIRST_TASK_TITLE_MAX_LENGTH),
      details: z.string().max(FIRST_TASK_DETAILS_MAX_LENGTH).optional(),
    })
    .optional(),
});

export type ApplyOnboardingSeed = z.infer<typeof applyOnboardingSeedSchema>;
