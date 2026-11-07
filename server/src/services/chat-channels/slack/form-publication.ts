import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { chatActions, chatEndpoints } from "@paperclipai/db";
import { parseSlackFormBinding } from "./cloud-forms.js";
import { SlackCloudReceiptError } from "./cloud-event.js";
import { slackFormSetupRecord } from "./cloud-forms.js";
import { chatPublications, type Db } from "@paperclipai/db";
import { issueThreadInteractionService } from "../../issue-thread-interactions.js";
import type { EndpointRow } from "../runtime-types.js";
import { stageSlackFormPublication } from "./form-owner.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export function createSlackFormPublicationStage(db: Db) {
  return async (endpoint: EndpointRow, publication: typeof chatPublications.$inferSelect): Promise<((tx: Tx) => Promise<void>) | null> => {
    if (endpoint.provider !== "slack" || !slackFormSetupRecord(endpoint.setup).slackCloudForms || !publication.issueId
      || typeof publication.payload.interactionId !== "string" || publication.companyId !== endpoint.companyId || publication.endpointId !== endpoint.id) return null;
    const interaction = (await issueThreadInteractionService(db).listForIssue(publication.issueId))
      .find(value => value.id === publication.payload.interactionId && value.companyId === endpoint.companyId && value.status === "pending");
    if (!interaction) return null;
    const [current] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, endpoint.id), eq(chatEndpoints.companyId, endpoint.companyId))).limit(1);
    const setup = current ? slackFormSetupRecord(current.setup) : undefined;
    const binding = parseSlackFormBinding(setup?.slackCloudForms);
    const [owner] = await db.select().from(chatActions).where(and(eq(chatActions.companyId, endpoint.companyId), eq(chatActions.endpointId, endpoint.id),
      eq(chatActions.kind, "slack_form_owner"), sql`${chatActions.payload}->'binding' = ${JSON.stringify(binding)}::jsonb`, sql`${chatActions.result}->>'phase' = 'enrolled'`)).limit(1);
    if (!current || !["active", "verifying", "attention"].includes(current.status) || setup?.runtimeGeneration !== binding.runtimeGeneration
      || current.publicId !== binding.publicId || current.connectionId !== binding.connectionId || binding.companyId !== endpoint.companyId
      || binding.endpointId !== endpoint.id || setup?.slackCloudInstanceId !== binding.instanceId || owner?.payload.subject !== setup?.slackCloudSubject
      || !isDeepStrictEqual(setup?.slackCloudForms, binding) || typeof owner?.payload.environment !== "string")
      throw new SlackCloudReceiptError("form_publication_enrollment_pending", "retry");
    return async tx => { await stageSlackFormPublication(tx, publication.id, interaction); };
  };
}
