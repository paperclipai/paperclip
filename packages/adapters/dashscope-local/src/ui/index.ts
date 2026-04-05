// UI components for DashScope adapter
import { models } from "../index.js";
import { buildDashScopeLocalConfig } from "./build-config.js";

export { models };
export { buildDashScopeLocalConfig };

export const configFields = [
  { 
    key: "model", 
    label: "Model", 
    type: "select", 
    required: true,
    options: models.map(m => ({ value: m.id, label: m.label }))
  },
  { 
    key: "baseUrl", 
    label: "API Base URL (optional)", 
    type: "text", 
    required: false,
    placeholder: "Leave empty for standard endpoint",
    help: "Leave empty to use standard DashScope endpoint"
  },
  {
    key: "env",
    label: "Environment Variables",
    type: "env",
  },
  { 
    key: "temperature", 
    label: "Temperature", 
    type: "number", 
    min: 0, 
    max: 2, 
    step: 0.1,
    default: 0.7
  },
  { 
    key: "topP", 
    label: "Top P", 
    type: "number", 
    min: 0, 
    max: 1, 
    step: 0.05,
    default: 0.8
  },
  { 
    key: "maxTokens", 
    label: "Max Tokens", 
    type: "number", 
    min: 1,
    default: 2048
  },
];

/**
 * List available DashScope models
 * Can be called dynamically by UI to populate model dropdown
 */
export async function listModels() {
  // Return static list from index.ts
  // In future, could fetch from DashScope API dynamically
  return models;
}
