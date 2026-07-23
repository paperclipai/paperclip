#!/usr/bin/env python3
"""Group redacted WordPress/wpdev log signatures without mutating source logs."""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, unquote_plus, urlencode, urlsplit, urlunsplit

ERROR_MARKERS = (
    "PHP Fatal error:",
    "PHP Parse error:",
    "PHP Warning:",
    "PHP Notice:",
    "PHP Deprecated:",
    "WordPress database error",
    "[Elementor:ERROR]",
    "[Elementor:WARNING]",
    "[EF save-validation]",
    "possible dead lock",
    "Failed to load translations",
)
ACCESS = re.compile(
    r'^\S+\s+\S+\s+\S+\s+\[([^]]+)]\s+"([A-Z]+)\s+([^ ]+)\s+HTTP/[^"]+"\s+(\d{3})\s+'
)
OLS_TS = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)")
WP_TS = re.compile(r"^\[([^]]+)]")
LOG_SECRET = re.compile(
    r"(?<![\w-])([A-Za-z_][\w.-]*)"
    r"(\s*(?:=(?!//)|:(?!//))\s*)(\"[^\"]*\"|'[^']*'|[^\s,&;]+)",
    re.I,
)
AUTHORIZATION = re.compile(
    r"\b(authorization\b\s*[:=]\s*)(?:Bearer\s+)?(\"[^\"]*\"|'[^']*'|[^\s,&;]+)",
    re.I,
)
BEARER = re.compile(r"\bBearer\s+[^\s,;]+", re.I)
URL = re.compile(r"https?://[^\s\"'<>]+", re.I)
SENSITIVE_KEY_PARTS = frozenset({
    "authorization",
    "cookie",
    "nonce",
    "passwd",
    "password",
    "secret",
    "token",
})


def parse_timestamp(line: str) -> datetime | None:
    access = ACCESS.match(line)
    if access:
        return datetime.strptime(access.group(1), "%d/%b/%Y:%H:%M:%S %z")
    match = OLS_TS.match(line)
    if match:
        return datetime.fromisoformat(match.group(1)).replace(tzinfo=timezone.utc)
    match = WP_TS.match(line)
    if match:
        for fmt in ("%d-%b-%Y %H:%M:%S %Z", "%d/%b/%Y:%H:%M:%S %z"):
            try:
                value = datetime.strptime(match.group(1), fmt)
                return value.replace(tzinfo=value.tzinfo or timezone.utc)
            except ValueError:
                pass
    return None


def iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def is_sensitive_key(raw: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]+", "_", unquote_plus(raw).casefold()).strip("_")
    parts = normalized.split("_")
    return (
        normalized in {"apikey", "wpnonce"}
        or bool(SENSITIVE_KEY_PARTS.intersection(parts))
        or normalized.endswith(("nonce", "passwd", "password", "secret", "token"))
        or (bool(parts) and parts[-1] == "key")
    )


def redact_params(raw: str) -> str:
    params = []
    for key, value in parse_qsl(raw.replace(";", "&"), keep_blank_values=True):
        if is_sensitive_key(key):
            value = "<redacted>"
        elif value.isdigit():
            value = "<id>"
        params.append((key, value))
    return urlencode(params)


def redact_url(raw: str) -> str:
    try:
        parsed = urlsplit(raw)
        segments = parsed.path.split("/")
        for index, segment in enumerate(segments):
            if segment.isdigit():
                segments[index] = "<id>"
            elif index and is_sensitive_key(segments[index - 1]):
                segments[index] = "<redacted>"
        path = "/".join(segments)
        netloc = parsed.netloc
        if parsed.username is not None or parsed.password is not None:
            host = parsed.hostname or ""
            if ":" in host:
                host = f"[{host}]"
            netloc = f"<redacted>@{host}"
            if parsed.port is not None:
                netloc += f":{parsed.port}"
        return urlunsplit((parsed.scheme, netloc, path, redact_params(parsed.query), redact_params(parsed.fragment)))
    except ValueError:
        return "<malformed-target>"


def redact_json_bodies(value: str) -> str:
    def redact(item: object) -> object:
        if isinstance(item, dict):
            return {key: "<redacted>" if is_sensitive_key(key) else redact(child) for key, child in item.items()}
        if isinstance(item, list):
            return [redact(child) for child in item]
        return item

    start = value.find("{")
    if start < 0:
        return value
    try:
        body, end = json.JSONDecoder().raw_decode(value[start:])
    except json.JSONDecodeError:
        return value[:start] + "<redacted>"
    return value[:start] + json.dumps(redact(body), separators=(",", ":")) + redact_json_bodies(value[start + end:])


def redact_secrets(value: str) -> str:
    value = redact_json_bodies(value)
    value = AUTHORIZATION.sub(lambda match: f"{match.group(1)}<redacted>", value)
    value = BEARER.sub("Bearer <redacted>", value)
    return LOG_SECRET.sub(
        lambda match: f"{match.group(1)}{match.group(2)}<redacted>" if is_sensitive_key(match.group(1)) else match.group(0),
        value,
    )


def normalize_message(line: str, root: Path) -> str | None:
    if not any(marker in line for marker in ERROR_MARKERS):
        return None
    message = line.split("[STDERR] ", 1)[-1]
    message = re.sub(r"^\[[^]]+]\s*", "", message)
    message = message.replace(str(root) + "/", "<workspace>/")
    message = re.sub(r"<workspace>/releases/[^/]+/", "<workspace>/releases/<release>/", message)
    message = re.sub(r"\?ver=[\w.-]+", "?ver=<version>", message)
    message = re.sub(r"\bline \d+\b", "line <n>", message)
    message = re.sub(r"\b(post|post_id|meta_id)=\d+\b", r"\1=<id>", message)
    message = re.sub(r"Duplicate entry '[^']+'", "Duplicate entry '<value>'", message)
    message = URL.sub(lambda match: redact_url(match.group(0)), message)
    message = redact_secrets(message)
    message = re.sub(r"\s+", " ", message).strip()
    if "No request delivery notification" in message:
        return "OpenLiteSpeed: No request delivery notification received from LSAPI application; possible dead lock"
    return message


def discover_sites(root: Path, requested: list[str]) -> list[str]:
    if requested:
        return sorted(set(requested))
    sites = {path.name for path in (root / "sites").iterdir() if path.is_dir()} if (root / "sites").is_dir() else set()
    log_root = root / ".wpdev" / "ols-docker" / "logs"
    if log_root.is_dir():
        for path in log_root.glob("*-error.log"):
            sites.add(path.name.removesuffix("-error.log"))
        for path in log_root.glob("*-access.log"):
            sites.add(path.name.removesuffix("-access.log"))
    return sorted(sites)


def candidate_files(root: Path, site: str) -> list[tuple[str, Path]]:
    log_root = root / ".wpdev" / "ols-docker" / "logs"
    return [
        ("error", log_root / f"{site}-error.log"),
        ("access", log_root / f"{site}-access.log"),
        ("debug", root / "sites" / site / "wp-content" / "debug.log"),
    ]


def add_event(groups: dict, key: tuple, timestamp: datetime | None, path: Path, sample: str) -> None:
    event = groups[key]
    event["count"] += 1
    event["files"].add(str(path))
    if timestamp and (event["first"] is None or timestamp < event["first"]):
        event["first"] = timestamp
    if timestamp and (event["last"] is None or timestamp > event["last"]):
        event["last"] = timestamp
    if sample not in event["samples"] and len(event["samples"]) < 2:
        event["samples"].append(sample[:1000])


def audit(root: Path, sites: list[str], since: datetime | None) -> dict:
    groups = defaultdict(lambda: {"count": 0, "files": set(), "first": None, "last": None, "samples": []})
    files = []
    for site in sites:
        for kind, path in candidate_files(root, site):
            if not path.is_file():
                continue
            lines = path.read_text(errors="replace").splitlines()
            timestamps = [value for line in lines if (value := parse_timestamp(line))]
            files.append({
                "site": site,
                "kind": kind,
                "path": str(path),
                "bytes": path.stat().st_size,
                "lines": len(lines),
                "first_timestamp": iso(min(timestamps)) if timestamps else None,
                "last_timestamp": iso(max(timestamps)) if timestamps else None,
            })
            for line in lines:
                timestamp = parse_timestamp(line)
                if kind == "access":
                    match = ACCESS.match(line)
                    if not match or int(match.group(4)) < 400:
                        continue
                    stamp = datetime.strptime(match.group(1), "%d/%b/%Y:%H:%M:%S %z")
                    if since and stamp < since:
                        continue
                    method, target, status = match.group(2), redact_url(match.group(3)), int(match.group(4))
                    signature = f"{method} {target} -> HTTP {status}"
                    add_event(groups, (site, "http", str(status), signature), stamp, path, signature)
                    continue
                if since and (timestamp is None or timestamp < since):
                    continue
                signature = normalize_message(line, root)
                if signature:
                    severity = "fatal" if "Fatal error" in signature or "Parse error" in signature else "warning"
                    add_event(groups, (site, "log", severity, signature), timestamp, path, signature)
    events = []
    for (site, kind, severity, signature), event in groups.items():
        events.append({
            "site": site,
            "kind": kind,
            "severity": severity,
            "signature": signature,
            "count": event["count"],
            "first_timestamp": iso(event["first"]),
            "last_timestamp": iso(event["last"]),
            "files": sorted(event["files"]),
            "samples": event["samples"],
        })
    events.sort(key=lambda item: (item["site"], item["kind"], -item["count"], item["signature"]))
    return {
        "generated_at": iso(datetime.now(timezone.utc)),
        "root": str(root),
        "sites": sites,
        "files": sorted(files, key=lambda item: (item["site"], item["kind"])),
        "events": events,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="wpdev workspace root")
    parser.add_argument("--site", action="append", default=[], help="site name; repeatable; default discovers all")
    parser.add_argument("--since", help="inclusive ISO-8601 timestamp")
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    since = datetime.fromisoformat(args.since.replace("Z", "+00:00")) if args.since else None
    if since and not since.tzinfo:
        since = since.replace(tzinfo=timezone.utc)
    print(json.dumps(audit(root, discover_sites(root, args.site), since), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
