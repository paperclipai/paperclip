import { z } from "zod";
import { AGENT_ADAPTER_TYPES } from "./constants.js";

export const agentAdapterTypeSchema = z
  .string()
  .trim()
  .min(1)
  .default("process")
  .describe(`Known built-in adapters: ${AGENT_ADAPTER_TYPES.join(", ")}. External adapters may register additional non-empty string types at runtime.`);

export const optionalAgentAdapterTypeSchema = z
  .string()
  .trim()
  .min(1)
  .optional();
