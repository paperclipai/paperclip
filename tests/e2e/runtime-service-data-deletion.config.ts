import { defineConfig } from "@playwright/test";
import base from "./runtime-services.config";

// Real UI with page-only provider responses for interruption and stale polling.
// Provider deletion and physical file cleanup are tested through host operations.
export default defineConfig({ ...base, testMatch: "runtime-service-data-deletion.spec.ts" });
