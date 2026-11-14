import type { Db } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { redactCurrentUserValue } from "../log-redaction.js";
import { redactEventPayload } from "../redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";
import { sharedDeliveryRead, type LiveDeliveryReads } from "../realtime/live-event-delivery.js";

export function createLiveRunEventRedactor(db: Db) {
  const settings = instanceSettingsService(db);
  const redactions = createRunSecretRedactionRegistry(db);
  return async (event: LiveEvent, reads?: LiveDeliveryReads): Promise<LiveEvent | null> => {
    const runId = event.payload.runId;
    if (typeof runId !== "string") return null;
    const redacted = redactCurrentUserValue({ ...event,
      payload: redactEventPayload(event.payload) ?? {},
    }, { enabled: await sharedDeliveryRead(reads, "censor-usernames", async () => (await settings.getGeneral()).censorUsernameInLogs) });
    const redact = await sharedDeliveryRead(reads, `secrets:${event.companyId}:${runId}`, () => redactions.redactorForRun(event.companyId, runId));
    return redact(redacted);
  };
}
