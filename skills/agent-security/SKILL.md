---
name: agent-security
description: Use when configuring agent sandboxing, security policies, inference routing, or evaluating the security posture of agent deployments. Covers isolation, network policies, and credential management.
---

# Agent Security Skill

Based on NemoClaw patterns for secure agent deployment.

## Security Layers

### 1. Network Policies
Control which external services agents can reach:
```yaml
network:
  # Allow only specific domains
  allow:
    - "api.anthropic.com"
    - "api.openai.com"
    - "*.googleapis.com"
  # Block everything else by default
  default: deny
```

### 2. Filesystem Restrictions
Limit what agents can read/write:
```yaml
filesystem:
  read:
    - "/home/user/project/**"
    - "/tmp/**"
  write:
    - "/home/user/project/src/**"
    - "/tmp/**"
  deny:
    - "/etc/**"
    - "/home/user/.ssh/**"
    - "**/.env"
    - "**/credentials*"
```

### 3. Process Isolation
Container-based isolation for untrusted operations:
- Run agent workloads in Docker containers
- Limit CPU/memory resources
- No host network access
- Read-only filesystem with specific write mounts

### 4. Credential Management
- **Never** store API keys in agent configs or code
- Use environment variables or secret managers
- Rotate credentials regularly
- Separate credentials per agent/company

## Security Checklist for Paperclip Agents

- [ ] API keys stored in `.env` or Paperclip secrets, never in adapter_config
- [ ] Agent cwd restricted to company workspace (`~/paperclip-workspaces/{company}/`)
- [ ] Heartbeat maxConcurrentRuns limited (prevents runaway agents)
- [ ] maxTurnsPerRun capped (prevents infinite loops)
- [ ] effort level set appropriately (prevents excessive API spend)
- [ ] Sensitive files (.env, credentials) excluded from agent access
- [ ] Network access limited to required APIs only

## Inference Routing
Route model API calls through controlled providers:
- Primary: Anthropic (Claude models)
- Secondary: Google (Gemini models)
- Fallback: Local models (Ollama)
- Keep provider credentials on host, not in agent context

## Monitoring
- Log all agent actions with timestamps
- Alert on unusual patterns: excessive API calls, file access outside cwd
- Review agent outputs periodically
- Track token usage per agent/company
