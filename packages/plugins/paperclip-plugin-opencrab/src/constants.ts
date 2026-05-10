export const PLUGIN_ID = "fmg.opencrab-ontology";
export const PLUGIN_VERSION = "0.1.0";

export const TOOL_NAMES = {
  status: "status",
  query: "query",
  searchDocuments: "search-documents",
  searchNodes: "search-nodes",
  getNodeContext: "get-node-context",
  searchPacks: "search-packs",
} as const;

export type OpenCrabToolKey = typeof TOOL_NAMES[keyof typeof TOOL_NAMES];
