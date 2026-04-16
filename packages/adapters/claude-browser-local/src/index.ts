export const type = "claude_browser_local";
export const label = "Claude (browser, local)";

export const models = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
];

export const agentConfigurationDoc = `# claude_browser_local agent configuration

Adapter: claude_browser_local

This adapter drives a long-lived Playwright sidecar from Paperclip. The sidecar
owns a persistent Chromium profile and executes a fixed BrowserTool surface
(goto, click, type, select, wait_for, screenshot, dom_snapshot, read_inbox,
solve_captcha, submit_form, save_artifact).

Core fields:
- cwd (string, optional): working directory for the adapter process.
- model (string, optional): Claude model id used for prompt authoring.
- sidecarSocketPath (string, optional): unix socket path for the Playwright
  sidecar. Defaults to \`/var/run/paperclip/claude-browser-local.sock\`.
- profileDir (string, optional): persistent Chromium profile directory.
  Defaults to \`/var/lib/surfer/profile\`.
- egressAllowlist (string[], optional): hostnames reachable from the sidecar
  netns. Enforced via iptables in the sidecar container.
- captcha (object, optional):
  - provider: "2captcha" (Week 1) | "anticaptcha" (future)
  - apiKeyEnv: env var name holding the captcha API key
  - monthlyCapUsd: hard cap, defaults to 20
- imap (object, optional): read-only IMAP config for the signups mailbox.
  - host, port, secure, userEnv, passEnv, mailbox (default "INBOX")
- secrets (object, optional): map of \`{{SECRET:NAME}}\` tokens to resolver
  sources. Resolution happens inside the sidecar only; secrets never flow
  back to the Paperclip server.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds.
- graceSec (number, optional): SIGTERM grace period in seconds.

Security posture:
- Prompts see \`{{SECRET:*}}\` opaque tokens only.
- Screenshot + DOM snapshot redaction runs inside the sidecar before any upload.
- Egress is allowlist-only on the sidecar container.
- Captcha spend is hard-capped; exceeding the cap refuses further solves.
- IMAP is read-only; a single-writer mailbox lock is enforced per agent.
`;
