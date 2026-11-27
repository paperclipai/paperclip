import { createWakeAdmissionWriter, createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { registerRetainedChatTests } from "./chat-channels.retained-fixture.js";

registerRetainedChatTests(0, { createWakeAdmissionWriter, createPostgresWakeQueueAdapter });

export type RetainedWakeQueueFixtures = {
  createWakeAdmissionWriter: typeof createWakeAdmissionWriter;
  createPostgresWakeQueueAdapter: typeof createPostgresWakeQueueAdapter;
};
