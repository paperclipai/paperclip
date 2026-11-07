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
    return async tx => { await stageSlackFormPublication(tx, publication.id, interaction); };
  };
}
