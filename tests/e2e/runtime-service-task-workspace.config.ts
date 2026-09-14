import { defineConfig } from "@playwright/test";
import base from "./runtime-services.config";

// UI transport-failure fixture. Provider allocation and native file continuity
// have separate production-operation tests; this does not simulate live Daytona.
export default defineConfig({ ...base, testMatch: "runtime-service-task-workspace.spec.ts" });
