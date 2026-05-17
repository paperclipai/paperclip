import { z } from "zod";

export const waitlistSignupSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  role: z.enum(["captain", "first_officer", "chief_pilot", "dispatch", "ops_manager", "other"]),
  organization: z.string().max(200).optional(),
  source: z.string().max(100).optional(),
  referralCode: z.string().max(20).optional(),
  utmSource: z.string().max(200).optional(),
  utmMedium: z.string().max(200).optional(),
  utmCampaign: z.string().max(200).optional(),
  utmTerm: z.string().max(200).optional(),
  utmContent: z.string().max(200).optional(),
});

export type WaitlistSignupInput = z.infer<typeof waitlistSignupSchema>;

export const waitlistSignupResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  queuePosition: z.number(),
  referralCode: z.string(),
  tier: z.string(),
  status: z.string(),
});

export type WaitlistSignupResponse = z.infer<typeof waitlistSignupResponseSchema>;

export const referralTrackSchema = z.object({
  referralCode: z.string().min(1).max(20),
  refereeEmail: z.string().email().max(320),
  refereeName: z.string().min(1).max(200).optional(),
});

export type ReferralTrackInput = z.infer<typeof referralTrackSchema>;

export const emailTriggerSchema = z.object({
  waitlistEntryId: z.string().uuid(),
  templateName: z.string().min(1),
  immediate: z.boolean().default(true),
});

export type EmailTriggerInput = z.infer<typeof emailTriggerSchema>;

export const emailTemplates = [
  "waitlist_confirmation",
  "referral_invite",
  "beta_invitation",
  "beta_welcome_day1",
  "onboarding_tips_day2",
  "feature_spotlight_day4",
  "week1_checkin_day7",
  "conversion_30d",
  "conversion_14d",
  "conversion_7d",
  "beta_expired",
  "reengagement_14d",
  "exit_survey",
] as const;

export type EmailTemplateName = (typeof emailTemplates)[number];

export const waitlistStatuses = [
  "waitlisted",
  "invited",
  "activated",
  "converted",
  "churned",
] as const;

export type WaitlistStatus = (typeof waitlistStatuses)[number];

export const referralTiers = [
  "standard",
  "priority",
  "insider",
] as const;

export type ReferralTier = (typeof referralTiers)[number];

export const crewbriefEnvSchema = z.object({
  CREWBRIEF_HUBSPOT_ACCESS_TOKEN: z.string().optional(),
  CREWBRIEF_HUBSPOT_EMAIL_SENDING: z.coerce.boolean().default(false),
  CREWBRIEF_POSTHOG_API_KEY: z.string().optional(),
  CREWBRIEF_POSTHOG_HOST: z.string().default("https://app.posthog.com"),
  CREWBRIEF_POSTHOG_CLIENT_KEY: z.string().optional(),
  CREWBRIEF_LINKEDIN_PARTNER_ID: z.string().optional(),
  CREWBRIEF_FROM_EMAIL: z.string().email().default("nurture@crewbrief.avva.aero"),
  CREWBRIEF_FROM_NAME: z.string().default("CrewBrief Team"),
  CREWBRIEF_BASE_URL: z.string().default("https://crewbrief.avva.aero"),
  CREWBRIEF_EMAIL_PROVIDER: z.enum(["console", "smtp", "resend"]).default("console"),
  CREWBRIEF_SMTP_HOST: z.string().optional(),
  CREWBRIEF_SMTP_PORT: z.coerce.number().default(587),
  CREWBRIEF_SMTP_USER: z.string().optional(),
  CREWBRIEF_SMTP_PASS: z.string().optional(),
  CREWBRIEF_RESEND_API_KEY: z.string().optional(),
});

export const webhookEventSchema = z.object({
  eventType: z.enum(["delivered", "open", "click", "unsubscribe", "enrollment", "completion"]),
  email: z.string().email(),
  subject: z.string().optional(),
  linkUrl: z.string().optional(),
  deviceType: z.string().optional(),
  sequenceName: z.string().optional(),
  emailId: z.string().optional(),
  contactId: z.string().optional(),
  source: z.string().optional(),
  emailsClicked: z.number().optional(),
  eventId: z.string().optional(),
  occurredAt: z.string().optional(),
});

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export const enrollmentCheckSchema = z.object({
  waitlistEntryId: z.string().uuid(),
  sequenceId: z.enum(["seq1_beta_welcome", "seq2_cold_reengagement", "seq3_trial_conversion"]),
});

export type EnrollmentCheckInput = z.infer<typeof enrollmentCheckSchema>;

export const sequenceInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  triggerDescription: z.string(),
  emailCount: z.number(),
});

export type SequenceInfo = z.infer<typeof sequenceInfoSchema>;

export type CrewbriefConfig = z.infer<typeof crewbriefEnvSchema>;
