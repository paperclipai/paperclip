import { defineConfig } from "@playwright/test";
import base from "./playwright-native-ingestion.config";
process.env.PAPERCLIP_INGESTION_COMPANION_PROTOCOL = "blocked-stop-history-v1";
export default defineConfig({ ...base, testMatch: "native-event-ingestion-blocked-stop.journey.ts", timeout: 900_000,
  retries: 0, workers: 1, use: { ...base.use, trace: "off", video: "off" } });
