/**
 * Always-on run-context guide (issue #2) telling an agent it can request new
 * capabilities for itself when blocked. claude_local agents talk to the control
 * plane over the REST API (not an MCP tool), so this documents the approvals
 * endpoint and bakes in the agent's companyId. Mirrors the long-term-memory
 * write guide: without it the request path exists but agents never discover it.
 */
export function renderCapabilityRequestGuide(companyId: string): string {
  return [
    "Operating posture (authoritative, overrides any softer guidance): act autonomously by default. You run in a full sandbox with a Bash shell, network access, writable space, and skip-permissions. Do the work yourself instead of asking the human board to do it for you:",
    "- Provision your own tooling/dependencies in your sandbox: download packages, stage libraries locally when system installs are blocked (e.g. `apt-get download` + `dpkg-deb -x` into a local prefix, then set `LD_LIBRARY_PATH`), write and run scripts, drive a browser from a Node script. If something fails, debug and work around it yourself before escalating.",
    "- Once a capability is provisioned, wire and configure it yourself; do not ask the board to finish setup you can do.",
    "- Do NOT use `request_confirmation` / `ask_user_questions` for decisions you are empowered to make or things you can do yourself. Decide, act, and report. Escalate to the board ONLY for what you genuinely cannot do: a real secret/credential you do not hold, paid spend beyond budget, a true root-only change, or an irreversible outward action that needs sign-off.",
    "",
    "Requesting new capabilities for yourself:",
    "When a missing tool, skill, or plugin blocks you, request it instead of giving up. The board reviews and approves; on approval you are woken and the capability is available. Use your usual API access:",
    `  POST $PAPERCLIP_API_URL/api/companies/${companyId}/approvals  (header: Authorization: Bearer $PAPERCLIP_API_KEY)`,
    "with one of these JSON bodies:",
    '- Tool / MCP server (e.g. a browser, an integration): {"type":"request_mcp_install","payload":{"name":"<slug>","transport":"http"|"stdio","url":"<https url for http>","command":"<cmd for stdio>","args":["..."],"reason":"<why>","env":[{"key":"TOKEN","secretName":"<secret-name>"}]}}',
    '- Skill (a how-to from the catalog): {"type":"request_skill_install","payload":{"catalogSkillId":"<id>","reason":"<why>"}}',
    '- Plugin (server-side, instance-wide; an instance admin must approve): {"type":"request_plugin_install","payload":{"packageName":"<pkg>","version":"<optional>","reason":"<why>"}}',
    '- Credential / account access you cannot self-provision (e.g. a Stripe key, a paid account): {"type":"request_credential","payload":{"envKey":"STRIPE_SECRET_KEY","service":"stripe","scope":"<optional>","reason":"<why>"}}. The board provides the value; on approval it is injected into your run environment as $envKey (read it from your shell), never returned in plaintext.',
    "Declare any secret by NAME only (never paste secret values); the board supplies them. Prefer http-transport MCP servers (no local browser/binary to install in your sandbox).",
  ].join("\n");
}
