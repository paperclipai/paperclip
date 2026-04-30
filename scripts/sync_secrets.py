#!/usr/bin/env python3
"""Koenig AI Academy — secret sync.

Reads .env.koenig, creates each secret in Paperclip's encrypted store, then
binds each to every agent that declared the corresponding env var as a secret
in .paperclip.yaml. Idempotent: re-running updates existing secrets in place.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

# Maps secret name -> list of agent slugs (urlKey) that should bind to it.
# Mirrors the inputs.env declarations in companies/learnova-academy/.paperclip.yaml.
SECRET_BINDINGS: dict[str, list[str]] = {
    "TAVILY_API_KEY": [
        "researcher-anthropic",
        "researcher-openai",
        "researcher-google",
        "researcher-community",
        "content-author",
    ],
    "XAI_API_KEY": ["researcher-anthropic", "researcher-community"],
    "RESEND_API_KEY": ["ceo"],
    "GH_TOKEN": [
        "ceo",
        "chief-engineering",
        "planner",
        "executor",
        "code-reviewer",
    ],
    "ACADEMY_AGENT_API_KEY": ["content-author"],
}


def parse_env_file(path: str) -> dict[str, str]:
    """Read .env file. Skips comments + blanks. Strips quotes."""
    out: dict[str, str] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if value:
                out[key] = value
    return out


def http(method: str, url: str, body: dict[str, Any] | None = None) -> Any:
    """Minimal JSON HTTP wrapper."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if body else {},
    )
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        msg = e.read().decode()[:300]
        raise RuntimeError(f"HTTP {e.code} on {method} {url}: {msg}") from e


def get_or_create_secret(
    paperclip_url: str, company_id: str, name: str, value: str, existing: dict[str, dict]
) -> str:
    """Create the secret if missing; rotate value if already exists. Returns secret id."""
    if name in existing:
        sid = existing[name]["id"]
        # Rotate value
        http("POST", f"{paperclip_url}/api/secrets/{sid}/rotate", {"value": value})
        print(f"  ↻ rotated   {name}  ({sid[:8]}…)")
        return sid

    body = {"name": name, "value": value, "providerId": "local_encrypted"}
    created = http("POST", f"{paperclip_url}/api/companies/{company_id}/secrets", body)
    sid = created["id"]
    print(f"  + created   {name}  ({sid[:8]}…)")
    return sid


def bind_secret_to_agent(
    paperclip_url: str, agent: dict, secret_name: str, secret_id: str
) -> str:
    """Add secret_ref to agent.adapterConfig.env. Returns 'updated' | 'unchanged'."""
    cfg = (agent.get("adapterConfig") or {}).copy()
    env = (cfg.get("env") or {}).copy()

    new_binding = {"type": "secret_ref", "secretId": secret_id}
    cur = env.get(secret_name)
    if (
        isinstance(cur, dict)
        and cur.get("type") == "secret_ref"
        and cur.get("secretId") == secret_id
    ):
        return "unchanged"

    env[secret_name] = new_binding
    cfg["env"] = env

    http("PATCH", f"{paperclip_url}/api/agents/{agent['id']}", {"adapterConfig": cfg})
    return "updated"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", required=True)
    ap.add_argument("--paperclip-url", required=True)
    ap.add_argument("--company-id", required=True)
    args = ap.parse_args()

    env = parse_env_file(args.env_file)
    if not env:
        print("ERROR: no values found in env file", file=sys.stderr)
        return 1

    print(f"Read {len(env)} non-empty values from {args.env_file}")
    print()

    # Fetch agents + existing secrets in parallel-ish (sequential, fast enough)
    agents = http("GET", f"{args.paperclip_url}/api/companies/{args.company_id}/agents")
    existing_secrets_list = http(
        "GET", f"{args.paperclip_url}/api/companies/{args.company_id}/secrets"
    )
    existing = {s["name"]: s for s in existing_secrets_list}
    by_slug = {a["urlKey"]: a for a in agents}

    print(f"Found {len(agents)} agents, {len(existing)} existing secrets in Paperclip")
    print()

    summary: dict[str, dict[str, int]] = {}

    for name, value in env.items():
        bindings = SECRET_BINDINGS.get(name)
        if bindings is None:
            print(f"⚠ {name} — no binding rule (skipping; add to SECRET_BINDINGS in script)")
            continue

        print(f"→ {name}")
        secret_id = get_or_create_secret(
            args.paperclip_url, args.company_id, name, value, existing
        )

        updated = unchanged = missing = 0
        for slug in bindings:
            agent = by_slug.get(slug)
            if not agent:
                print(f"  ✗ skip {slug:30s} (agent not found)")
                missing += 1
                continue
            result = bind_secret_to_agent(args.paperclip_url, agent, name, secret_id)
            symbol = "✓" if result == "updated" else "·"
            print(f"  {symbol} {result:9s}  {slug}")
            if result == "updated":
                updated += 1
            else:
                unchanged += 1

        summary[name] = {"updated": updated, "unchanged": unchanged, "missing": missing}
        print()

    print("──────── Summary ────────")
    for name, s in summary.items():
        print(
            f"  {name:25s}  bound: {s['updated'] + s['unchanged']:2d}  new: {s['updated']:2d}  missing: {s['missing']}"
        )

    print()
    print("Verify in UI: http://localhost:3100/agents/all")
    print(
        "Each agent's Config tab → Environment variables should now show the bound secret(s)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
