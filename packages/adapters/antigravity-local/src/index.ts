export const type = "antigravity_local";
export const label = "Antigravity (local)";

// `agy --model` accepts BOTH the dashed id and the display name. Verified against the live CLI
// on 2026-08-05 — an earlier comment here claimed the dashed form was "REJECTED as not recognized",
// and that was WRONG. It shipped, validation was built on it, and it broke four correctly
// configured TSBC bench lanes (422 on their own current model). Do not reinstate that claim.
//
//   $ agy models                                   -> dashed ids are what agy reports as canonical
//   $ agy --print … --model "gemini-3.1-pro-high"  -> OK
//   $ agy --print … --model "Gemini 3.1 Pro (High)" -> OK
//   $ agy --print … --model "claude-opus-4-6-thinking"
//        -> "Individual quota reached" for the Claude band, i.e. it RESOLVED. Valid.
//
// The dashed ids are listed FIRST because `agy models` is the source of truth; the display names
// follow as accepted aliases so existing lanes configured either way keep validating. If this list
// is ever regenerated, derive it from `agy models` output — never from a hand-written display list.
//
// The Claude and GPT-OSS entries matter commercially, not just technically: on the Google AI
// Pro plan they draw on usage bands SEPARATE from Gemini's. Before this list existed the
// adapter offered one generic "Antigravity" entry and never passed --model at all, so every
// lane ran on the Gemini default and those paid bands were never consumed.
//
// Do not expose an unpinned session-default entry: every selectable model must be an explicit
// `agy --model` value so Paperclip can persist and compare the declared model per run.
export const models = [
  // Canonical ids, exactly as `agy models` reports them.
  { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash (High)" },
  { id: "gemini-3.5-flash-medium", label: "Gemini 3.5 Flash (Medium)" },
  { id: "gemini-3.5-flash-low", label: "Gemini 3.5 Flash (Low)" },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking) — separate usage band" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking) — separate usage band" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium) — separate usage band" },
  // Accepted display-name aliases — agy takes these too, and live lanes are configured with them.
  { id: "Gemini 3.6 Flash (High)", label: "Gemini 3.6 Flash (High)" },
  { id: "Gemini 3.6 Flash (Medium)", label: "Gemini 3.6 Flash (Medium)" },
  { id: "Gemini 3.6 Flash (Low)", label: "Gemini 3.6 Flash (Low)" },
  { id: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash (High)" },
  { id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)" },
  { id: "Gemini 3.5 Flash (Low)", label: "Gemini 3.5 Flash (Low)" },
  { id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)" },
  { id: "Gemini 3.1 Pro (Low)", label: "Gemini 3.1 Pro (Low)" },
  { id: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6 (Thinking) — separate usage band" },
  { id: "Claude Opus 4.6 (Thinking)", label: "Claude Opus 4.6 (Thinking) — separate usage band" },
  { id: "GPT-OSS 120B (Medium)", label: "GPT-OSS 120B (Medium) — separate usage band" },
];

export const agentConfigurationDoc = `# antigravity_local agent configuration

Adapter: antigravity_local

Use when:
- You want Paperclip to run Google's Antigravity \`agy\` CLI locally on the host machine
- The host has already completed local \`agy\` login
- You want Paperclip to resume saved Antigravity conversations with \`--conversation <id>\`

Don't use when:
- You need API-key based authentication. This adapter uses local \`agy\` login and does not require or read a Google API key.
- Antigravity is not installed or authenticated on the machine that runs Paperclip
- You need a webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file. Paperclip stages it into the execution workspace as \`AGENTS.md\` when possible.
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "agy"
- printTimeout (string, optional): \`agy --print-timeout\` value. Defaults to \`5m0s\`.
- autoApprove (boolean, optional): pass \`--dangerously-skip-permissions\` for unattended execution. Defaults to true.
- sandbox (boolean, optional): pass \`--sandbox\`. Defaults to false.
- extraDirs (string[], optional): additional workspace directories passed as repeated \`--add-dir\`.
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
- maxTokensPerRun (number, required-by-default): live stream-json token ceiling. Defaults to 100000; Paperclip terminates the local run before another model step after the ceiling is crossed.

Notes:
- Runs use \`agy --print <prompt> --output-format stream-json\` for non-interactive execution and enforceable usage telemetry.
- Sessions resume with \`--conversation <sessionId>\` when the saved session cwd matches the current cwd.
- Authentication is managed by the local Antigravity CLI. Run \`agy\` login/setup on the host before assigning this adapter.
`;
