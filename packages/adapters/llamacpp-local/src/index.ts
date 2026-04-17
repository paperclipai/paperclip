export const type = "llamacpp_local";
export const label = "Llama.cpp / Local (experimental)";

export const models = [
  { id: "qwen3.5-9b-q4", label: "Qwen 3.5 9B (Q4 — 6GB VRAM)" },
  { id: "deepseek-r1:14b", label: "DeepSeek R1 14B (Q4 — 9GB VRAM)" },
  { id: "mistral-nemo-12b-q4", label: "Mistral Nemo 12B (Q4 — 7.5GB VRAM)" },
  { id: "qwen3.5-4b-q4", label: "Qwen 3.5 4B (Q4 — 2.5GB VRAM)" },
];

export const agentConfigurationDoc = `# llamacpp_local agent configuration

Adapter: llamacpp_local

Use when:
- Running local open-source models (Qwen, DeepSeek, Llama)
- Privacy-critical work (no cloud API calls)
- Bandwidth-constrained environments
- Cost-optimized deployments

Don't use when:
- You need proprietary model features (Claude, GPT-4)
- Latency is critical (local inference is slower)
- Using models larger than your VRAM

Prerequisites:
- llama.cpp server running on localhost:8000 (or configured URL)
- Model downloaded and loaded in llama.cpp
- ~8-12GB VRAM minimum for practical models

Core fields:
- cwd (string): working directory for agent
- model (string): model identifier (e.g. "qwen3.5-9b-q4")
- llamacppUrl (string): URL to llama.cpp server (default: http://localhost:8000)
- contextLimit (number): max context window (default: 8192)
- tools (boolean): enable tool calling (default: true)

Optional fields:
- sessionStorage (string): "memory" or "sqlite" for persistence
- compressionLevel (string): "lite", "full", "ultra" (default: "full")
- temperature (number): sampling temperature (default: 0.7)
- topP (number): nucleus sampling (default: 0.9)
`;