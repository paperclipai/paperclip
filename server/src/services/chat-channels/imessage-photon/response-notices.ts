import { chatActions, chatPublications, type Db } from "@paperclipai/db";
import { notifyChatPublicationWork } from "../../chat-work-notifications.js";
import { projectSafeChatPublicationText } from "../../chat-publication-projection.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Keep the notice marker and its outbox row in the same owner transaction. */
export async function stagePhotonResponseNotice(tx: Tx, input: {
  publication: typeof chatPublications.$inferSelect;
  reference: string;
  questionIndex: number;
  key: string;
  text: string;
}) {
  const { publication, reference, questionIndex, key, text } = input;
  await tx.insert(chatActions).values({
    companyId: publication.companyId, endpointId: publication.endpointId, conversationId: publication.conversationId,
    kind: "photon_response_notice", providerActionId: `photon-notice:${key}`,
    payload: { reference, questionIndex, publicationId: publication.id }, status: "processed",
  }).onConflictDoNothing();
  await notifyChatPublicationWork(tx);
  await tx.insert(chatPublications).values({
    companyId: publication.companyId, endpointId: publication.endpointId, conversationId: publication.conversationId,
    issueId: publication.issueId, idempotencyKey: key,
    payload: { ...publication.payload, card: undefined, text: projectSafeChatPublicationText(text) }, state: "pending",
  }).onConflictDoNothing();
}
