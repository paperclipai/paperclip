#!/usr/bin/env python3
"""Disposable seven-UID permission probe; run only in an isolated container."""

import json
import os
from pathlib import Path
import shutil
import sys
from urllib import error, parse, request

from verify_boundary import root_owned_chain


SERVICES = (
    ("pc-cron-watchdog", "paperclip-cron-agent-watchdog.token"),
    ("pc-disk-guard", "paperclip.token"),
    ("pc-watch-12320", "paperclip.token"),
    ("pc-watch-12340", "paperclip.token"),
    ("pc-watch-12359", "paperclip.token"),
    ("pc-cron-quota", "paperclip-cron-quota-rewake.token"),
    ("pc-fleet-watch", "paperclip.token"),
)


def as_uid(uid, action):
    child = os.fork()
    if child == 0:
        try:
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
            action()
        except Exception as exc:
            os.write(2, f"UID {uid}: {type(exc).__name__}: {exc}\n".encode())
            os._exit(1)
        os._exit(0)
    _, status = os.waitpid(child, 0)
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        raise AssertionError(f"UID {uid} permission probe failed")


def denied(path):
    try:
        path.read_text()
    except PermissionError:
        return
    raise AssertionError("private source readable by foreign UID")


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_status(origin, token, action):
    method, path = action["method"], action["path"]
    if method not in ("GET", "POST", "PATCH") or not path.startswith("/api/"):
        raise ValueError("invalid fixture action")
    if parse.urlsplit(path).query or parse.urlsplit(path).fragment:
        raise ValueError("fixture action may not select a query or fragment")
    body = action.get("body")
    payload = None if body is None else json.dumps(body).encode()
    call = request.Request(origin + path, data=payload, method=method,
                           headers={"Authorization": "Bearer " + token,
                                    "Content-Type": "application/json"})
    opener = request.build_opener(NoRedirect())
    try:
        with opener.open(call, timeout=15) as response:
            response.read(1)
            return response.status
    except error.HTTPError as response:
        response.read(1)
        return response.code


def main():
    if len(sys.argv) not in (1, 2):
        raise SystemExit("usage: probe_uid_fixture.py [isolated-fixture-directory]")
    if os.geteuid() != 0 or not Path("/package/probe_uid_fixture.py").is_file():
        raise SystemExit("run only as container root with the package mounted read-only")
    fixture_dir = Path(sys.argv[1]) if len(sys.argv) == 2 else None
    manifest = json.loads((fixture_dir / "manifest.json").read_text()) if fixture_dir else None
    if manifest:
        parsed = parse.urlsplit(manifest["origin"])
        if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
                or not parsed.port or parsed.path or parsed.query or parsed.fragment):
            raise SystemExit("HTTP fixture must use a fixed loopback origin")
        if set(manifest["services"]) != {name for name, _ in SERVICES}:
            raise SystemExit("HTTP fixture must describe all seven services")
        os.chmod("/root", 0o700)
    code_dir = Path("/opt/paperclip-cron")
    code_dir.mkdir(parents=True, exist_ok=True)
    source = Path("/package/service_http.py")
    code = code_dir / source.name
    shutil.copyfile(source, code)
    code.chmod(0o755)
    root_owned_chain(code)
    agent_dir = Path("/home/agent-code")
    agent_dir.mkdir(parents=True)
    os.chown(agent_dir, 1000, 1000)
    redirected = agent_dir / "evil.py"
    redirected.write_text("pass\n")
    os.chown(redirected, 1000, 1000)
    link = code_dir / "evil.py"
    link.symlink_to(redirected)
    try:
        root_owned_chain(link)
    except ValueError:
        pass
    else:
        raise AssertionError("agent-owned symlink target passed the root chain check")

    sources = []
    for uid, (name, token_name) in enumerate(SERVICES, start=1101):
        home = Path("/var/lib") / name
        secret_dir = home / ".secrets"
        secret_dir.mkdir(parents=True)
        for directory in (home, secret_dir):
            os.chown(directory, uid, uid)
            directory.chmod(0o700)
        token = secret_dir / token_name
        if fixture_dir:
            shutil.copyfile(fixture_dir / f"{name}.token", token)
        else:
            token.write_text("fixture-only\n")
        os.chown(token, uid, uid)
        token.chmod(0o400)
        sources.append((uid, name, token))

    for uid, name, own in sources:
        def check_service():
            private_key = own.read_text().strip()
            if not private_key:
                raise AssertionError("service cannot read own fixture source")
            for other_uid, _, other in sources:
                if other_uid != uid:
                    denied(other)
            if fixture_dir:
                denied(fixture_dir / f"{name}.token")
            if os.access(code, os.W_OK) or os.access(code_dir, os.W_OK):
                raise AssertionError("service can change root-owned code")
            if manifest:
                scenarios = manifest["services"][name]
                allowed = http_status(manifest["origin"], private_key, scenarios["allowed"])
                forbidden = http_status(manifest["origin"], private_key, scenarios["denied"])
                if allowed != scenarios["allowed"]["status"] or forbidden != scenarios["denied"]["status"]:
                    raise AssertionError(f"{name} HTTP statuses {allowed}/{forbidden} differ from fixture")
                os.write(1, f"{name}: allowed={allowed} denied={forbidden}\n".encode())
        as_uid(uid, check_service)

    def check_agent():
        for _, _, token in sources:
            denied(token)
        if fixture_dir:
            for name, _ in SERVICES:
                denied(fixture_dir / f"{name}.token")
        if os.access(code, os.W_OK) or os.access(code_dir, os.W_OK):
            raise AssertionError("agent can change service executable path")
        if manifest:
            spec = manifest["agentDenied"]
            status = http_status(manifest["origin"], "pc_uid1000_no_host_credential", spec)
            if status != spec["status"]:
                raise AssertionError(f"agent UID HTTP denial was {status}")
            os.write(1, f"uid1000: denied={status}\n".encode())
    as_uid(1000, check_agent)
    print("7 service UIDs: own source readable, 42 cross-source reads denied; agent UID 1000: 7 reads denied; code writes and agent-owned symlink denied")


if __name__ == "__main__":
    main()
