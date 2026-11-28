import { createWakeAdmissionWriter, createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { registerRetainedChatTests } from "../chat-channels.retained-fixture.js";

registerRetainedChatTests(7, { createWakeAdmissionWriter, createPostgresWakeQueueAdapter });
