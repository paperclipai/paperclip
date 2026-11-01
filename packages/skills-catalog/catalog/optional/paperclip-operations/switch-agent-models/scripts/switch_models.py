#!/usr/bin/env python3
"""Switch agent models in one Paperclip company, with a plan, a snapshot and a way back.

Stdlib only. See ../SKILL.md for the workflow.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone

SUFFIX_RE = re.compile(r"\((max|high|medium|low)\)$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
CONNECTION_PREFIX = "paperclip/"
DEFAULT_SNAPSHOT_DIR = "~/.paperclip/model-switch-snapshots"
CONNECTION = "connection"
PROVIDER = "provider"


# ---------------------------------------------------------------- transport


def api_base() -> str:
    base = os.environ.get("PAPERCLIP_API_URL")
    if not base:
        fail("PAPERCLIP_API_URL is not set")
    return base.rstrip("/")


def request(method: str, path: str, payload: dict | None = None) -> tuple[int, object]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(f"{api_base()}{path}", data=body, method=method)
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    key = os.environ.get("PAPERCLIP_API_KEY")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, {"raw": raw.decode("utf-8", "replace")[:400]}
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return 0, {"error": str(error)}


def gateway_model_ids(args=None) -> list[str] | None:
    """Model ids the configured gateway serves, or None when no gateway is configured."""
    base = (getattr(args, "gateway_url", None) or os.environ.get("PAPERCLIP_GATEWAY_URL") or "").strip()
    if not base:
        return None
    req = urllib.request.Request(f"{base.rstrip('/')}/v1/models")
    key = getattr(args, "gateway_key", None) or os.environ.get("PAPERCLIP_GATEWAY_KEY")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            data = json.loads(response.read() or b"{}")
    except Exception:
        return None
    return [item.get("id") for item in data.get("data", []) if item.get("id")]


# ---------------------------------------------------------------- domain


def fail(message: str, code: int = 1) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(code)


def brief(payload: object) -> str:
    if isinstance(payload, dict):
        return str(payload.get("error") or payload.get("raw") or payload)
    return str(payload)[:200]


def list_companies() -> list[dict] | None:
    status, data = request("GET", "/api/companies")
    if status == 200 and isinstance(data, list):
        return data
    return None


def resolve_company(selector: str | None) -> dict:
    wanted = (selector or os.environ.get("PAPERCLIP_COMPANY_ID") or "").strip()
    # Listing companies needs board access; an agent key may only read its own
    # company, so an id is used as given and verified by the company-scoped call.
    if wanted and UUID_RE.match(wanted):
        return {"id": wanted.lower(), "name": None}
    companies = list_companies()
    if companies is None:
        fail("cannot list companies: this key may lack board access; pass --company <id> or set PAPERCLIP_COMPANY_ID")
    if not companies:
        fail("this instance has no companies")
    if not wanted:
        if len(companies) == 1:
            return companies[0]
        names = ", ".join(company.get("name", "?") for company in companies)
        fail(f"several companies exist, pass --company: {names}")
    wanted = wanted.lower()
    exact = [c for c in companies if str(c.get("id", "")).lower() == wanted or str(c.get("name", "")).lower() == wanted]
    if len(exact) == 1:
        return exact[0]
    partial = [
        c for c in companies
        if str(c.get("id", "")).lower().startswith(wanted) or str(c.get("name", "")).lower().startswith(wanted)
    ]
    if len(partial) == 1:
        return partial[0]
    if partial:
        fail(f"company {selector!r} is ambiguous: " + ", ".join(c.get("name", "?") for c in partial))
    fail(f"no company matches {selector!r}")


def list_agents(company_id: str) -> list[dict]:
    status, data = request("GET", f"/api/companies/{company_id}/agents")
    if status != 200 or not isinstance(data, list):
        fail(f"cannot list agents (HTTP {status}): {brief(data)}")
    return data


def connection_catalog(company_id: str) -> list[dict]:
    """Each connection with its routing kind and the model ids it lists."""
    status, data = request("GET", f"/api/companies/{company_id}/ai-connections")
    if status != 200 or not isinstance(data, dict):
        return []
    catalog: list[dict] = []
    for connection in data.get("connections", []):
        routing = connection.get("routing") or {}
        models = {model["id"] for model in routing.get("models") or [] if model.get("id")}
        catalog.append({"id": connection.get("id"), "provider": connection.get("provider"), "kind": routing.get("kind"), "models": models})
    return catalog


def connection_model_ids(catalog: list[dict]) -> set[str]:
    ids: set[str] = set()
    for connection in catalog:
        ids |= connection["models"]
    return ids


def bound_connection(agent: dict, catalog: list[dict]) -> dict | None:
    bound = (binding_of(agent) or {}).get("connectionId")
    return next((item for item in catalog if bound and item["id"] == bound), None)


def current_model(agent: dict) -> str:
    return ((agent.get("adapterConfig") or {}).get("model") or "").strip()


def binding_of(agent: dict) -> dict | None:
    binding = (agent.get("runtimeConfig") or {}).get("aiConnection")
    return binding if isinstance(binding, dict) and binding else None


ACPX_HARNESS = {"codex": "codex_local", "claude": "claude_local", "grok": "grok_local", "cursor": "cursor", "pi": "pi_local"}


def harness_of(agent: dict) -> str:
    """Mirror agentHarnessType from packages/shared/src/agent-runner.ts."""
    adapter = agent.get("adapterType") or ""
    config = agent.get("adapterConfig") or {}
    if adapter != "paperclip_runner":
        return adapter
    provider = config.get("provider")
    if provider is None or provider == "codex":
        return "codex_local"
    if provider == "opencode":
        return "opencode_local"
    if provider == "acpx":
        name = str(config.get("acpxAgent") or "claude")
        return ACPX_HARNESS.get(name, f"acpx:{name}")
    return str(provider)


def kind_of(agent: dict) -> str:
    # A bound AI connection decides the family. The prefix stays as a fallback
    # for records written before the binding existed.
    if binding_of(agent) is not None:
        return CONNECTION
    return CONNECTION if current_model(agent).startswith(CONNECTION_PREFIX) else PROVIDER


def suffix_of(model: str) -> str:
    match = SUFFIX_RE.search(model or "")
    return match.group(0) if match else ""


def with_suffix(model: str, suffix: str) -> str:
    """Append the previous reasoning suffix only when the target carries none."""
    if not suffix or SUFFIX_RE.search(model):
        return model
    return model + suffix


def model_prefix(agent: dict, catalog: list[dict]) -> str | None:
    """Return the harness transport prefix, or None when the route is unknown.

    Mirrors aiRoutingModel() in packages/shared/src/ai-provider-routing.ts and
    managedProviderRouting() in server/src/services/ai-provider-routing.ts.
    """
    harness = harness_of(agent)
    if harness not in ("opencode_local", "pi_local"):
        return ""
    binding = binding_of(agent)
    connection = bound_connection(agent, catalog)
    route = (connection or {}).get("kind")
    provider = (connection or {}).get("provider") or (binding or {}).get("provider")
    # A routed OpenRouter account and a native OpenRouter account name the same
    # provider, so both take the same prefix without needing routing.kind.
    if route == "openrouter" or (not route and provider == "openrouter"):
        return "openrouter/"
    if route:
        # aiRoutingModel prefixes OpenCode for other routes but leaves Pi bare.
        return "paperclip/" if harness == "opencode_local" else ""
    if harness == "pi_local":
        # Native Pi requires <provider>/<id>, including a responsible-user default.
        return f"{provider}/" if provider else None
    if binding:
        # A native non-OpenRouter account leaves OpenCode on its own provider
        # configuration, and the API does not say which model shape that takes.
        return None
    return "paperclip/"


def target_model(agent: dict, args, catalog: list[dict] | None = None) -> tuple[str | None, str]:
    """Return (model, note). None means this agent was not given a usable target."""
    suffix = "" if args.drop_suffix else suffix_of(current_model(agent))
    if kind_of(agent) == CONNECTION:
        source = args.connection_model or args.model
        if not source:
            return None, "needs --connection-model"
        prefix = model_prefix(agent, catalog or [])
        if prefix is None:
            return None, "cannot determine bound connection route"
        # The CLI argument is an upstream model ID, not a harness model value.
        # For example, openrouter/auto needs a second openrouter/ for OpenCode.
        return with_suffix(prefix + source, suffix), ""
    if not args.model:
        return None, "needs --model"
    return with_suffix(args.model, suffix), ""


def validate(agent: dict, model: str, catalog: list[dict], gateway: list[str] | None) -> tuple[bool, str]:
    if kind_of(agent) == CONNECTION:
        binding = binding_of(agent)
        connection = bound_connection(agent, catalog)
        if binding and not connection:
            return True, "unverified (bound connection unavailable)"
        ids = connection["models"] if connection else connection_model_ids(catalog)
        if not ids:
            return True, "unverified (no connection models)"
        bare = SUFFIX_RE.sub("", model)
        prefix = model_prefix(agent, catalog)
        if prefix and bare.startswith(prefix):
            bare = bare[len(prefix):]
        if bare in ids:
            return True, "connection model"
        return False, f"{bare} is not in the bound connection" if binding else f"{bare} is in no connection"
    if gateway is None:
        return True, "unverified (no gateway)"
    bare = SUFFIX_RE.sub("", model)
    if bare in gateway:
        return True, "gateway model"
    return False, f"{bare} is not served by the gateway"


def select(agents: list[dict], args) -> list[dict]:
    if args.all:
        return list(agents)
    if not args.select:
        return []
    picked: list[dict] = []
    for token in [part.strip() for part in args.select.split(",") if part.strip()]:
        if token.startswith("re:"):
            pattern = re.compile(token[3:])
            matches = [agent for agent in agents if pattern.search(agent.get("name", ""))]
        else:
            matches = [agent for agent in agents if agent.get("name") == token]
        if not matches:
            fail(f"no agent matches {token!r}")
        picked.extend(matches)
    seen: set[str] = set()
    unique = []
    for agent in picked:
        if agent["id"] not in seen:
            seen.add(agent["id"])
            unique.append(agent)
    return unique


# ---------------------------------------------------------------- render


def display_width(value: str) -> int:
    return sum(2 if unicodedata.east_asian_width(char) in ("W", "F") else 1 for char in value)


def pad(value: str, width: int) -> str:
    return value + " " * max(0, width - display_width(value))


def print_table(rows: list[dict]) -> None:
    headers = tuple(rows[0].keys()) if rows else ()
    widths = [display_width(header) for header in headers]
    for row in rows:
        for index, header in enumerate(headers):
            widths[index] = max(widths[index], display_width(str(row[header])))
    print("  ".join(pad(header, widths[index]) for index, header in enumerate(headers)))
    print("  ".join("-" * width for width in widths))
    for row in rows:
        print("  ".join(pad(str(row[header]), widths[index]) for index, header in enumerate(headers)))


# ---------------------------------------------------------------- commands


def company_from(argv_company: str | None) -> dict:
    return resolve_company(argv_company)


def cmd_companies(args) -> int:
    companies = list_companies()
    if companies is None:
        fail("cannot list companies: this key may lack board access")
    rows = [{"id": company.get("id", "?"), "name": company.get("name", "?")} for company in companies]
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print_table(rows)
    return 0


def cmd_list(args) -> int:
    company = company_from(args.company)
    rows = [
        {
            "agent": agent.get("name", "?"),
            "resolves": kind_of(agent),
            "harness": harness_of(agent),
            "model": current_model(agent) or "-",
        }
        for agent in list_agents(company["id"])
    ]
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print_table(rows)
    return 0


def build_plan(args) -> tuple[dict, list[dict], list[dict]]:
    company = company_from(args.company)
    agents = list_agents(company["id"])
    chosen = select(agents, args)
    if not chosen:
        fail("nothing selected: pass --select or --all")
    gateway = gateway_model_ids(args)
    catalog = connection_catalog(company["id"]) if any(kind_of(agent) == CONNECTION for agent in chosen) else []
    rows, entries = [], []
    for agent in chosen:
        model, note = target_model(agent, args, catalog)
        status = note
        if model is not None:
            ok, status = validate(agent, model, catalog, gateway)
            if not ok and args.force:
                status = f"{status} (forced)"
            elif not ok:
                model = None
        rows.append(
            {
                "agent": agent.get("name", "?"),
                "resolves": kind_of(agent),
                "before": current_model(agent) or "-",
                "after": model or "-",
                "validation": status,
            }
        )
        entries.append({"agent": agent, "after": model, "ok": model is not None})
    return company, rows, entries


def cmd_plan(args) -> int:
    _, rows, entries = build_plan(args)
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print_table(rows)
    blocked = sum(1 for entry in entries if not entry["ok"])
    if blocked:
        print(f"\n{blocked} agent(s) cannot be written as planned", file=sys.stderr)
        return 1
    print(f"\n{len(rows)} agent(s) ready")
    return 0


def snapshot_path(directory: str | None) -> str:
    folder = os.path.expanduser(directory or os.environ.get("PAPERCLIP_MODEL_SNAPSHOT_DIR") or DEFAULT_SNAPSHOT_DIR)
    os.makedirs(folder, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return os.path.join(folder, f"{stamp}-{os.getpid()}.json")


def write_snapshot(path: str, snapshot: dict) -> None:
    """Replace the snapshot atomically so a crash cannot leave it truncated."""
    descriptor, temp = tempfile.mkstemp(prefix=".model-switch-", dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(snapshot, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def create_snapshot(path: str, snapshot: dict) -> str:
    """Publish a complete private snapshot without replacing another run's file."""
    descriptor, temp = tempfile.mkstemp(prefix=".model-switch-", dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(snapshot, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(100):
            candidate = path if attempt == 0 else f"{path[: -len('.json')]}-{attempt}.json"
            try:
                os.link(temp, candidate)
                return candidate
            except FileExistsError:
                continue
        fail("cannot create a unique snapshot file")
    finally:
        os.unlink(temp)


def cmd_apply(args) -> int:
    company, rows, entries = build_plan(args)
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print_table(rows)
    if any(not entry["ok"] for entry in entries):
        print("\nrefusing to write: at least one agent failed validation", file=sys.stderr)
        return 1
    if not args.yes:
        print("\ndry run: pass --yes to write these changes", file=sys.stderr)
        return 0

    snapshot = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "apiUrl": api_base(),
        "companyId": company["id"],
        "companyName": company.get("name"),
        "agents": [
            {
                "id": entry["agent"]["id"],
                "name": entry["agent"].get("name"),
                "adapterType": entry["agent"].get("adapterType"),
                "before": current_model(entry["agent"]) or None,
                "after": entry["after"],
                "applied": False,
            }
            for entry in entries
        ],
    }
    path = create_snapshot(snapshot_path(args.snapshot_dir), snapshot)

    print(f"\nsnapshot: {path}", flush=True)
    failures = 0
    for index, entry in enumerate(entries):
        agent = entry["agent"]
        snapshot["agents"][index]["attempted"] = True
        write_snapshot(path, snapshot)
        status, data = request("PATCH", f"/api/agents/{agent['id']}", {"adapterConfig": {"model": entry["after"]}})
        written = ((data or {}).get("adapterConfig") or {}).get("model") if isinstance(data, dict) else None
        if status == 200 and written == entry["after"]:
            snapshot["agents"][index]["applied"] = True
            write_snapshot(path, snapshot)
            print(f"ok    {agent.get('name')}: {current_model(agent) or '-'} -> {entry['after']}")
            continue
        failures += 1
        print(f"FAIL  {agent.get('name')}: HTTP {status} {brief(data)}", file=sys.stderr)

    write_snapshot(path, snapshot)
    print(f"\nsnapshot: {path}")
    print(f"rollback: {os.path.basename(__file__)} rollback --snapshot {path} --yes")

    if failures:
        return 2
    return verify(snapshot) if args.verify else 0


def verify(snapshot: dict) -> int:
    agents = {agent["id"]: agent for agent in list_agents(snapshot["companyId"])}
    mismatches = 0
    for entry in snapshot["agents"]:
        if not entry.get("applied"):
            continue
        found = current_model(agents.get(entry["id"], {}))
        if found != entry["after"]:
            mismatches += 1
            print(f"MISMATCH {entry['name']}: expected {entry['after']}, found {found}", file=sys.stderr)
    print("verify: every applied model confirmed" if not mismatches else f"verify: {mismatches} mismatch(es)")
    return 0 if not mismatches else 2


def cmd_rollback(args) -> int:
    path = os.path.expanduser(args.snapshot)
    try:
        with open(path, encoding="utf-8") as handle:
            snapshot = json.load(handle)
    except OSError as error:
        fail(f"cannot read snapshot: {error}")
    if snapshot.get("apiUrl") and snapshot["apiUrl"].rstrip("/") != api_base():
        fail("snapshot belongs to a different API URL")
    agents = {agent["id"]: agent for agent in list_agents(snapshot["companyId"])}
    failures = 0
    for entry in snapshot.get("agents", []):
        if not entry.get("applied") and not entry.get("attempted"):
            print(f"skip  {entry.get('name')}: not attempted")
            continue
        if "before" not in entry:
            print(f"skip  {entry.get('name')}: snapshot records no previous model")
            continue
        before = entry.get("before")
        label = before if before else "(unset)"
        agent = agents.get(entry["id"])
        if not agent:
            failures += 1
            print(f"FAIL  {entry.get('name')}: agent not found", file=sys.stderr)
            continue
        found = current_model(agent) or None
        if found == before:
            print(f"skip  {entry.get('name')}: already restored")
            continue
        if found != entry.get("after"):
            failures += 1
            print(f"FAIL  {entry.get('name')}: model changed since apply; refusing to overwrite", file=sys.stderr)
            continue
        if not args.yes:
            print(f"would restore {entry.get('name')}: {entry.get('after')} -> {label}")
            continue
        status, data = request("PATCH", f"/api/agents/{entry['id']}", {"adapterConfig": {"model": before}})
        config = data.get("adapterConfig") if isinstance(data, dict) else None
        written = config.get("model") if isinstance(config, dict) else None
        if status == 200 and isinstance(config, dict) and written == before:
            print(f"ok    {entry.get('name')} -> {label}")
        else:
            failures += 1
            print(f"FAIL  {entry.get('name')}: HTTP {status}, expected {before!r}, got {written!r}: {brief(data)}", file=sys.stderr)
    if not args.yes:
        print("\ndry run: pass --yes to restore")
        return 2 if failures else 0
    return 0 if not failures else 2


# ---------------------------------------------------------------- cli


def add_gateway_flags(target: argparse.ArgumentParser) -> None:
    target.add_argument("--gateway-url", help="gateway base URL for provider-model validation (default: PAPERCLIP_GATEWAY_URL)")
    target.add_argument("--gateway-key", help="gateway bearer token (default: PAPERCLIP_GATEWAY_KEY)")


def add_target_flags(target: argparse.ArgumentParser) -> None:
    add_gateway_flags(target)
    target.add_argument("--select", help="agent names, comma separated, or re:<pattern>")
    target.add_argument("--all", action="store_true", help="select every agent")
    target.add_argument("--model", help="literal model value for agents that resolve through their provider")
    target.add_argument("--connection-model", help="upstream model id for agents bound to an AI connection (without a harness prefix)")
    target.add_argument("--drop-suffix", action="store_true", help="drop an existing (max)/(high) suffix")
    target.add_argument("--force", action="store_true", help="write even when a validation check fails")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Switch agent models in one Paperclip company.")
    parser.add_argument("--company", help="company id or name (default: the only company, or PAPERCLIP_COMPANY_ID)")
    parser.add_argument("--json", action="store_true", help="print tables as JSON")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("companies", help="list companies this instance knows")
    sub.add_parser("list", help="list agents, how each resolves its model, and the current model")

    plan = sub.add_parser("plan", help="resolve and validate targets without writing")
    add_target_flags(plan)

    apply_cmd = sub.add_parser("apply", help="write the resolved targets")
    add_target_flags(apply_cmd)
    apply_cmd.add_argument("--yes", action="store_true", help="really write")
    apply_cmd.add_argument("--verify", action="store_true", help="re-read every agent after writing")
    apply_cmd.add_argument("--snapshot-dir", help=f"default: {DEFAULT_SNAPSHOT_DIR}")

    rollback = sub.add_parser("rollback", help="restore models recorded in a snapshot")
    rollback.add_argument("--snapshot", required=True, help="snapshot file written by apply")
    rollback.add_argument("--yes", action="store_true", help="really restore")

    args = parser.parse_args(argv)
    handlers = {
        "companies": cmd_companies,
        "list": cmd_list,
        "plan": cmd_plan,
        "apply": cmd_apply,
        "rollback": cmd_rollback,
    }
    return handlers[args.command](args)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        raise SystemExit(130)
