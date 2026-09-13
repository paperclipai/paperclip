export const GOOGLE_VERTEX_ADAPTER_TYPE = "google_vertex";
export const GOOGLE_VERTEX_ADAPTER_LABEL = "Google Vertex AI";
export const GOOGLE_VERTEX_PROVIDER = "vertex";
export const DEFAULT_GOOGLE_VERTEX_MODEL = "google/gemini-3.8-flash";
export const DEFAULT_GOOGLE_VERTEX_REGION = "global";

/** Vertex's OpenAI-compatible endpoint has no model-list route. */
export const GOOGLE_VERTEX_MODELS = [
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
  { id: "google/gemini-3-pro-preview", label: "Gemini 3 Pro Preview" },
  { id: "google/gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
  { id: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite Preview" },
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
] as const;
