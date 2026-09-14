import { defineConfig } from "@playwright/test";
import base from "./runtime-services.config";
const webServer = base.webServer as Exclude<NonNullable<typeof base.webServer>, unknown[]>;
// Workers re-evaluate the base config; keep the original isolated server home.
process.env.PAPERCLIP_RETENTION_FIXTURE_HOME ??= webServer.env!.PAPERCLIP_HOME;
export default defineConfig({ ...base, testMatch: ["runtime-service-retention.spec.ts", "runtime-service-company-policy.spec.ts"] });
