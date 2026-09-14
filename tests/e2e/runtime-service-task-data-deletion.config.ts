import { defineConfig } from "@playwright/test";
import base from "./runtime-services.config";
const webServer = base.webServer as Exclude<NonNullable<typeof base.webServer>, unknown[]>;
// Workers re-evaluate the base config; keep the original isolated server home.
process.env.PAPERCLIP_TASK_DELETION_FIXTURE_HOME ??= webServer.env!.PAPERCLIP_HOME;
export default defineConfig({ ...base, testMatch: "runtime-service-task-data-deletion.spec.ts" });
