import { createWakeAdmissionWriter, createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { registerRetainedChatTests } from "../chat-channels.retained-fixture.js";

registerRetainedChatTests(2, { createWakeAdmissionWriter, createPostgresWakeQueueAdapter });
