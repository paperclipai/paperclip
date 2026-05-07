| name | raigo-governance |
| description | Apply raigo AI governance policy to every agent run in this Paperclip company. Enforces the organisation's `.raigo` policy file — blocking prohibited prompts, warning on sensitive topics, and logging policy decisions — before any agent acts. Use this skill whenever a Paperclip company has a `.raigo` policy file and wants deterministic, auditable governance across its entire agent fleet. |

# raigo Governance Skill

This skill wires the [raigo open standard](https://github.com/PericuloLimited/raigo) into Paperclip's agent execution loop. Every agent that loads this skill will evaluate its task prompt against the active `.raigo` policy before taking any action.

raigo is a YAML-based, vendor-neutral policy language for AI governance. A `.raigo` file declares what agents are allowed to do, what is blocked, what triggers a warning, and which compliance frameworks (HIPAA, SOC 2, GDPR, ISO 27001, etc.) apply. The raigo compiler converts that file into native enforcement artifacts; the raigo engine evaluates prompts at runtime via a single HTTP call.

## When to Use

Load this skill on any Paperclip agent or company that:

- operates under a formal compliance requirement (HIPAA, SOC 2, GDPR, FCA, ISO 27001)
- handles sensitive data classifications (PHI, PII, financial records, source code, credentials)
- needs a consistent, auditable record of what each agent was and was not permitted to do
- runs in a regulated industry where human-readable policy files are required for audit

## How raigo Works in Paperclip

raigo can be used in two modes. Both are compatible with Paperclip.

**Compiler mode (no infrastructure required).** The raigo CLI compiles a `.raigo` file into a Paperclip-native skill artifact. The output is a structured Markdown block that you drop into `.agents/skills/`. Every agent that loads the skill has the policy baked into its context at startup. This is the zero-infrastructure path: no engine to run, no HTTP calls, no secrets to manage.

```bash
# Install the raigo CLI
npm install -g @periculo/raigo

# Compile your policy for Paperclip
raigo compile policy.raigo --target paperclip

# Output: .agents/skills/raigo-policy/SKILL.md
# Drop it into your repo and every agent picks it up automatically
```

**Engine mode (runtime enforcement).** The raigo engine runs as a lightweight sidecar service. Before each agent run, call `POST /v1/evaluate` with the task prompt. The engine returns a deterministic `ALLOW`, `DENY`, or `WARN` decision in under 10 ms. This is the recommended path for production deployments where you need real-time blocking and a full audit trail.

```bash
# Self-host the engine (Docker)
docker run -p 8080:8080 -v $(pwd)/policy.raigo:/policy.raigo \
  ghcr.io/periculolimited/raigo-engine:latest

# Or use raigo cloud (managed, no infrastructure)
# https://cloud.raigo.ai
```

## Enforcement Protocol

When this skill is active, every agent MUST follow this protocol before acting on any task:

### Step 1 — Locate the active policy

Look for a `.raigo` file in the repository root. If none exists, check for a `raigo.yaml` or `raigo.yml` file. If no policy file is found, proceed with the default safe posture defined in Step 4.

### Step 2 — Evaluate the task prompt

**If using engine mode:** Send the task prompt to the raigo engine before taking any action.

```
POST /v1/evaluate
Content-Type: application/json

{
  "prompt": "<the full task text>",
  "context": {
    "agent_id": "<paperclip agent id>",
    "company_id": "<paperclip company id>",
    "run_id": "<paperclip run id>"
  }
}
```

The engine responds with one of three decisions:

| Decision | Meaning | Required action |
|---|---|---|
| `ALLOW` | Prompt is within policy | Proceed normally |
| `WARN` | Prompt touches a sensitive area | Proceed, but prepend the `policyMessage` to your response |
| `DENY` | Prompt violates policy | Stop immediately. Do not act. Report the `policyMessage` to the Paperclip issue as a comment. |

**If using compiler mode:** The compiled policy rules are embedded in this skill file (below the `## Active Policy Rules` section if present). Evaluate the task prompt against each rule manually before proceeding.

### Step 3 — Handle DENY decisions

When the raigo engine (or a compiled rule) returns `DENY`:

1. Do not execute the task.
2. Do not call any tools, write any files, or make any API calls.
3. Add a comment to the Paperclip issue with the exact text: `[raigo] Task blocked by policy: <policyMessage>`.
4. Set the run status to `failed` with reason `policy_violation`.
5. Log the decision: agent ID, run ID, rule ID, timestamp, and the first 200 characters of the blocked prompt.

### Step 4 — Default safe posture (no policy file)

If no `.raigo` file is found, apply these baseline rules:

- Never transmit credentials, API keys, tokens, or secrets to external systems.
- Never write or execute code that deletes data without explicit confirmation in the task description.
- Never impersonate a human or claim to be a person when communicating externally.
- Never access systems or data outside the scope defined in the task description.
- Flag any task that involves financial transactions, legal commitments, or public communications for human review before proceeding.

## Policy File Reference

A minimal `.raigo` file for a Paperclip deployment:

```yaml
raigo_version: "0.3.0"
metadata:
  organisation: "Acme Corp"
  policy_suite: "Paperclip Agent Governance"
  version: "1.0.0"
  effective_date: "2026-01-01"
  owner: "Security Team"

context:
  data_classifications:
    - id: "CREDENTIALS"
      description: "API keys, tokens, passwords, private keys"
    - id: "PII"
      description: "Personally identifiable information"

policies:
  - id: "SEC-01"
    domain: "Security"
    title: "Block credential exfiltration"
    condition:
      trigger: "output_contains"
      data_classification: ["CREDENTIALS"]
    action: "DENY"
    severity: "critical"
    directive: "Never transmit credentials or secrets outside approved internal systems."
    enforcement_message: "BLOCKED [SEC-01]: Credential transmission is prohibited."
    audit_required: true

  - id: "PII-01"
    domain: "Data Privacy"
    title: "Warn on PII handling"
    condition:
      trigger: "output_contains"
      data_classification: ["PII"]
    action: "WARN"
    severity: "high"
    directive: "Flag any task involving personal data for review."
    enforcement_message: "WARNING [PII-01]: This task involves personal data. Ensure handling complies with your data protection policy."
    audit_required: true
```

Run `raigo compile policy.raigo --target paperclip` to convert this into a compiled skill artifact. Run `raigo validate policy.raigo` to check the file before deploying.

## Audit and Compliance

Every policy decision — ALLOW, WARN, or DENY — should be logged with:

- `timestamp` (ISO 8601 UTC)
- `agent_id` (Paperclip agent ID)
- `run_id` (Paperclip run ID)
- `rule_id` (raigo rule ID that triggered, or `none` for ALLOW)
- `decision` (`ALLOW` | `WARN` | `DENY`)
- `prompt_hash` (SHA-256 of the first 500 characters of the prompt)

This log is the audit trail required by SOC 2 CC6.1, HIPAA §164.312(b), and ISO 27001 A.12.4.1. The raigo engine produces this log automatically when running in engine mode. In compiler mode, the agent is responsible for writing this log to the Paperclip activity feed.

## Resources

- raigo specification: https://github.com/PericuloLimited/raigo/blob/main/SPECIFICATION.md
- raigo cloud (managed engine + policy UI): https://cloud.raigo.ai
- raigo Discord community: https://discord.gg/8VDgbrju
- Example `.raigo` policies: https://github.com/PericuloLimited/raigo/tree/main/examples
- Compiler targets: `openai`, `anthropic`, `cursor`, `copilot`, `paperclip`, and 20+ others
