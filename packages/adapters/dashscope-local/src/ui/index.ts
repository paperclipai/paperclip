// UI components for DashScope adapter (placeholder)
export const configFields = [
  { key: "model", label: "Model", type: "select", required: true },
  { key: "temperature", label: "Temperature", type: "number", min: 0, max: 2, step: 0.1 },
  { key: "topP", label: "Top P", type: "number", min: 0, max: 1, step: 0.05 },
  { key: "maxTokens", label: "Max Tokens", type: "number", min: 1 },
];
