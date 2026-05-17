import type { CrewbriefPosthogService } from "./crewbrief-posthog.js";
import type { CrewbriefNurtureService } from "./crewbrief-nurture.js";

interface HubSpotWebhookEvent {
  eventType: "delivered" | "open" | "click" | "unsubscribe" | "enrollment" | "completion";
  email: string;
  subject?: string;
  linkUrl?: string;
  deviceType?: string;
  sequenceName?: string;
  emailId?: string;
  contactId?: string;
  source?: string;
  emailsClicked?: number;
  eventId?: string;
  occurredAt?: string;
}

export function crewbriefWebhookService(
  posthog: CrewbriefPosthogService,
  nurture: CrewbriefNurtureService,
) {
  const EVENT_MAP: Record<string, string> = {
    delivered: "email_delivered",
    open: "email_opened",
    click: "email_clicked",
    unsubscribe: "email_unsubscribed",
    enrollment: "sequence_enrolled",
    completion: "sequence_completed",
  };

  async function handleHubSpotEvent(event: HubSpotWebhookEvent): Promise<void> {
    const phEvent = EVENT_MAP[event.eventType];
    if (!phEvent) return;

    const properties: Record<string, unknown> = {
      sequence_name: event.sequenceName,
      email_subject: event.subject,
      email_id: event.emailId,
      event_id: event.eventId,
      occurred_at: event.occurredAt,
    };

    if (event.eventType === "click" && event.linkUrl) {
      properties.link_url = event.linkUrl;
    }
    if (event.eventType === "open" && event.deviceType) {
      properties.device_type = event.deviceType;
    }
    if (event.eventType === "unsubscribe") {
      properties.source = event.source || "email_link";
    }
    if (event.eventType === "completion") {
      properties.emails_clicked = event.emailsClicked || 0;
    }
    if (event.eventType === "enrollment") {
      properties.contact_id = event.contactId;
    }

    await nurture.handleEmailEvent(phEvent, event.email, properties);
  }

  async function handleBatchHubSpotEvents(events: HubSpotWebhookEvent[]): Promise<void> {
    for (const event of events) {
      await handleHubSpotEvent(event);
    }
  }

  return {
    handleHubSpotEvent,
    handleBatchHubSpotEvents,
  };
}

export type CrewbriefWebhookService = ReturnType<typeof crewbriefWebhookService>;
