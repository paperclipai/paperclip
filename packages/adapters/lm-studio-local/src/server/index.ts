export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listLmStudioModels } from "./models.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { sessionCodec as codexSessionCodec } from "@paperclipai/adapter-codex-local/server";

// Reuse the codex session codec since we use the same underlying Codex binary
export const sessionCodec: AdapterSessionCodec = codexSessionCodec;
