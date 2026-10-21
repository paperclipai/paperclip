#!/usr/bin/env python3
"""Muse Secure Vault transport; profile is nonsecret and operation identities are durable."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlparse
VERSION = "3"
REQUEST_TIMEOUT_SECONDS = 120
ROOT = Path.home() / ".config" / "paperclip-muse"
HOOK_ROOT = Path.home() / "hooks" / "scripts"
AUTHD_HELPER_PATH = Path("/opt/hatch/skills/skill-creator/bin/dynamic_credentials.py")
AUTHD = None
MAX_BYTES = 2_000_000
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None
HTTP = urllib.request.build_opener(NoRedirect)
def canonical(value): return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream, ensure_ascii=False); stream.flush(); os.fsync(stream.fileno())
    os.chmod(temporary, 0o600); os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)
def origin(value):
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise RuntimeError("A public HTTPS Paperclip origin is required")
    return value.rstrip("/")
def authd():
    global AUTHD
    if AUTHD is None:
        try:
            spec = importlib.util.spec_from_file_location("paperclip_muse_dynamic_credentials", AUTHD_HELPER_PATH)
            if spec is None or spec.loader is None: raise RuntimeError()
            helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
            AUTHD = helper
        except Exception:
            raise RuntimeError("Muse Secure Vault helper is unavailable; use the supported runtime") from None
    return AUTHD
class BoundedResponse:
    def __init__(self, response): self.response = response; self.remaining = MAX_BYTES
    def __getattr__(self, name): return getattr(self.response, name)
    def read(self, amount=None):
        limit = self.remaining + 1 if amount is None or amount < 0 else min(amount, self.remaining + 1)
        data = self.response.read(limit)
        if len(data) > self.remaining: raise RuntimeError("Paperclip response exceeds transport limit")
        self.remaining -= len(data); return data
def http(url, body=None, credential_name=None):
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RuntimeError("Invalid Paperclip endpoint")
    if parsed.path not in ("/api/muse/v1/queries", "/api/muse/v1/commands", "/api/muse/v1/cleanup", "/api/muse/v1/detector-cleanup"):
        raise RuntimeError("Unsupported worker transport endpoint")
    if not credential_name or not credential_name.startswith("custom.paperclip-muse-"):
        raise RuntimeError("Configure this binding's Muse Secure Vault connection first")
    headers = {"Accept": "application/json"}
    if body is not None: headers["Content-Type"] = "application/json"
    encoded = None if body is None else canonical(body)
    if encoded is not None and len(encoded) > 262144: raise RuntimeError("Command exceeds transport limit")
    request = urllib.request.Request(url, encoded, headers)
    helper = authd()
    try:
        helper.add_surrogate_to_request(request, credential_name=credential_name, entry_name="access_token", allowed_hosts=[parsed.hostname])
    except Exception:
        raise RuntimeError("Muse Secure Vault authorization unavailable; reconnect using the supported consent flow") from None
    return request_json(request, helper.read_json_response)
def timeout_failure():
    return RuntimeError("transport_timeout_or_permission_wait: review any pending Muse site approval; then repeat the same read or inspect the original command receipt")
def request_json(request, decode):
    try:
        with HTTP.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            if response.status != 200 or response.headers.get_content_type() != "application/json": raise RuntimeError("Incomplete Paperclip protocol response")
            try: value = decode(BoundedResponse(response))
            except TimeoutError: raise
            except Exception: raise RuntimeError("Paperclip response is invalid or exceeds the transport limit") from None
            if not isinstance(value, dict): raise RuntimeError("Invalid Paperclip protocol response")
            return value
    except urllib.error.HTTPError as error:
        raise RuntimeError("Paperclip HTTP %d; inspect connection or receipt before retrying" % error.code) from None
    except TimeoutError:
        raise timeout_failure() from None
    except urllib.error.URLError as error:
        if isinstance(error.reason, TimeoutError): raise timeout_failure() from None
        raise RuntimeError("Paperclip transport unavailable; review Muse site approval before retrying the same request") from None
def public_preflight(base):
    base = origin(base)
    request = urllib.request.Request(base + "/api/muse/v1/oauth/metadata", headers={"Accept": "application/json"})
    value = request_json(request, lambda response: json.loads(response.read()))
    if value.get("resource") != base + "/api/muse/v1" or value.get("issuer") != base + "/api/muse/v1/oauth":
        raise RuntimeError("Public Paperclip metadata does not match the configured connection")
    return {"status": "site_approval_preflight_complete", "origin": base, "clientVersion": VERSION}

class Client:
    def __init__(self, binding):
        if str(uuid.UUID(binding)) != binding: raise RuntimeError("A canonical binding UUID is required")
        self.binding = binding; self.directory = ROOT / binding
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700); os.chmod(self.directory, 0o700)
        self.lock = open(self.directory / "client.lock", "a"); os.chmod(self.directory / "client.lock", 0o600)
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        self.path = self.directory / "connection.json"
        self.config = json.loads(self.path.read_text()) if self.path.exists() else None
        if self.config is not None: self.validate_profile(self.config)
        self.publication = self.directory / "connection-commit.json"
        if self.publication.exists():
            staged = json.loads(self.publication.read_text()); self.validate_profile(staged)
            self._publish_profile(staged); self.publication.unlink(); self.sync_directory()
    def close(self): self.lock.close()
    def credential_name(self):
        if self.config is None: raise RuntimeError("Configure this binding's nonsecret connection profile first")
        return self.config["credentialName"]
    def validate_profile(self, value):
        required = {"version", "bindingId", "origin", "credentialName"}
        if not isinstance(value, dict) or not required.issubset(value) or set(value) - required - {"generation"} or value["version"] != 1 or value["bindingId"] != self.binding or value["credentialName"] != "custom.paperclip-muse-" + self.binding:
            raise RuntimeError("Unexpected connection profile")
        origin(value["origin"])
        if "generation" in value and (type(value["generation"]) is not int or value["generation"] < 1): raise RuntimeError("Invalid connection generation")
    def configure(self, base):
        value = {"version": 1, "bindingId": self.binding, "origin": origin(base), "credentialName": "custom.paperclip-muse-" + self.binding}
        if self.config is not None:
            if self.config["origin"] != value["origin"]: raise RuntimeError("Configured connection origin changed; use a fresh binding")
            if "generation" in self.config: value["generation"] = self.config["generation"]
        save(self.publication, value); self._publish_profile(value); self.publication.unlink(); self.sync_directory()
        return {"configured": True, "bindingId": self.binding, "provider": "paperclip-muse-" + self.binding, "version": VERSION}
    def sync_directory(self):
        descriptor = os.open(self.directory, os.O_RDONLY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
    def _publish_profile(self, value):
        self.config = value; save(self.path, value)
        save(self.directory / "receiver.json", {"version": 1, "origin": value["origin"], "bindingId": self.binding})
        HOOK_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        wrapper = HOOK_ROOT / ("paperclip-muse-" + self.binding + ".sh")
        temporary = wrapper.with_name(wrapper.name + ".tmp")
        content = '#!/usr/bin/env bash\nexec bash "$HOME/.config/paperclip-muse/detector.sh" "' + self.binding + '"\n'
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o700)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        os.chmod(temporary, 0o700); os.replace(temporary, wrapper)
        descriptor = os.open(HOOK_ROOT, os.O_RDONLY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
    def remember_identity(self, value):
        if value.get("bindingId") != self.binding or type(value.get("generation")) is not int or value["generation"] < 1:
            raise RuntimeError("Authenticated identity does not match this connection")
        if "generation" in self.config and self.config["generation"] != value["generation"]:
            raise RuntimeError("Connection generation changed; preserve prior receipts and follow reconnect instructions")
        self.config["generation"] = value["generation"]; save(self.path, self.config)
    def generation(self):
        if self.config is None: raise RuntimeError("Configure this binding first")
        if "generation" not in self.config: self.remember_identity(self.query({"query": "identify"}))
        return self.config["generation"]
    def query(self, value):
        return http(self.config["origin"] + "/api/muse/v1/queries", {"version": 1, **value}, self.credential_name())
    def journal_path(self, key):
        return self.directory / "journal" / (hashlib.sha256(key.encode()).hexdigest() + ".json")
    def receipt(self, key):
        path = self.journal_path(key)
        if not path.exists(): raise RuntimeError("No prepared command for that key")
        journal = json.loads(path.read_text())
        command = journal["command"]
        if "assignmentId" not in command:
            return {"requestId": command["requestId"], "command": command["command"], "state": journal["state"], "receipt": journal.get("receipt"), "instruction": "Retry only the same command key and unchanged input to inspect its durable idle receipt"}
        result = self.query({"query": "operation.receipt", "assignmentId": command["assignmentId"], "requestId": command["requestId"]})
        journal["receipt"] = result; journal["state"] = "received"; save(path, journal)
        return {"assignmentId": command["assignmentId"], "requestId": command["requestId"], "receipt": result}
    def mailbox(self, acknowledge=None):
        self.generation()
        path = self.directory / "mailbox.json"
        state = json.loads(path.read_text()) if path.exists() else {"bindingId": self.binding, "generation": self.config["generation"], "ackedThrough": 0}
        if state["bindingId"] != self.binding or state["generation"] != self.config["generation"]: raise RuntimeError("Mailbox generation changed; reconnect instructions are required")
        if acknowledge is not None:
            if acknowledge != state.get("batch", {}).get("nextCursor") or acknowledge < state["ackedThrough"]: raise RuntimeError("Acknowledge only the exact durably saved batch cursor")
            state["ackedThrough"] = acknowledge; state.pop("batch", None); save(path, state)
            return {"status": "acknowledged", "nextCursor": acknowledge}
        result = self.query({"query": "mailbox", "after": state["ackedThrough"]})
        if result.get("bindingId") != self.binding or result.get("generation") != self.config["generation"] or not isinstance(result.get("items"), list) or not isinstance(result.get("nextCursor"), int) or result["nextCursor"] < state["ackedThrough"]: raise RuntimeError("Mailbox response identity or cursor changed")
        state["batch"] = result; save(path, state)
        return result
    def status(self):
        identity = self.query({"query": "identify", "clientVersion": VERSION})
        self.remember_identity(identity)
        identity["localPendingCommands"] = sum(1 for path in (self.directory / "journal").glob("*.json") if json.loads(path.read_text()).get("receipt", {}).get("status", "pending") in ("pending", "reserved", "dispatched", "unknown"))
        identity["instructionsPath"] = str(ROOT / "instructions.md")
        return identity
    def command(self, key, value):
        path = self.journal_path(key)
        value = {"version": 1, **value}
        proposed = {k: v for k, v in value.items() if k != "requestId"}
        digest = hashlib.sha256(canonical(proposed)).hexdigest()
        if path.exists():
            journal = json.loads(path.read_text())
            if journal["digest"] != digest: raise RuntimeError("Stable command key reused with different input")
        else:
            journal = {"digest": digest, "command": {**value, "requestId": value.get("requestId", str(uuid.uuid4()))}, "state": "prepared"}
            save(path, journal)
        if journal.get("receipt", {}).get("status") in ("unknown", "rejected"):
            raise RuntimeError("Operation is unresolved or rejected; inspect its original receipt without replay")
        if journal.get("receipt", {}).get("status") not in ("pending", "reserved", "dispatched") and "receipt" in journal: return journal["receipt"]
        # Persist dispatch intent before issuing the stable command. A lost ACK
        # is inspected using exactly this requestId, never a replacement effect.
        journal["state"] = "sending"; save(path, journal)
        result = http(self.config["origin"] + "/api/muse/v1/commands", journal["command"], self.credential_name())
        journal["receipt"] = result; journal["state"] = "received"; save(path, journal)
        return result
    def detector_cleanup(self, removed):
        # Invoke only after an explicit runtime removal request/confirmation.
        generation = self.generation()
        if type(generation) is not int or generation < 1: raise RuntimeError("Invalid cleanup generation")
        kind = "detector-cleanup:" + ("removed" if removed else "requested")
        path = self.directory / "control" / (kind + ":g" + str(generation) + ".json")
        legacy = self.directory / "control" / (kind + ".json")
        if path.exists(): journal = json.loads(path.read_text())
        else:
            old = json.loads(legacy.read_text()) if legacy.exists() else None
            # Preserve a prepared older-client identity only for this exact
            # generation. A reconnect never adopts another generation's facts.
            if old and old.get("request", {}).get("bindingId") == self.binding and old["request"].get("generation") == generation:
                journal = old
            else:
                body = {"version": 1, "requestId": str(uuid.uuid4()), "bindingId": self.binding, "generation": generation, "detectorRemoved" if removed else "detectorRemovalRequested": True}
                journal = {"request": body}
            save(path, journal)
        if journal["request"]["bindingId"] != self.binding or journal["request"]["generation"] != self.config["generation"]: raise RuntimeError("Cleanup identity changed")
        if "receipt" not in journal:
            journal["receipt"] = http(self.config["origin"] + "/api/muse/v1/detector-cleanup", journal["request"], self.credential_name())
            save(path, journal)
        return journal["receipt"]
    def answer(self, assignment, request):
        self.generation()
        value = self.query({"query": "input.pending", "assignmentId": assignment, "nativeRequestId": request})
        if value.get("status") == "pending": return value
        if value.get("assignmentId") != assignment or value.get("bindingId") != self.binding or value.get("generation") != self.config["generation"] or value.get("requestId") != request or not isinstance(value.get("turnId"), str) or not value["turnId"]: raise RuntimeError("Input response does not belong to this exact assignment and turn")
        path = self.directory / "continuations" / (assignment + ".json")
        old = json.loads(path.read_text()) if path.exists() else {"assignmentId": assignment, "inputs": {}}
        previous = old["inputs"].get(request)
        if previous and (previous["inputDigest"] != value["inputDigest"] or previous["turnId"] != value["turnId"]): raise RuntimeError("Input changed within a turn")
        old["inputs"][request] = {**value, "continuationReceiptId": previous["continuationReceiptId"] if previous else str(uuid.uuid4())}
        save(path, old)
        return old["inputs"][request]
    def consume(self, assignment, request):
        self.generation()
        continuation = json.loads((self.directory / "continuations" / (assignment + ".json")).read_text())
        value = continuation["inputs"][request]
        if continuation["assignmentId"] != assignment or value.get("assignmentId") != assignment or value.get("bindingId") != self.binding or value.get("generation") != self.config["generation"] or value.get("requestId") != request: raise RuntimeError("Continuation identity changed")
        current = self.query({"query": "input.pending", "assignmentId": assignment, "nativeRequestId": request})
        if any(current.get(field) != value.get(field) for field in ("assignmentId", "bindingId", "generation", "requestId", "turnId", "inputDigest")): raise RuntimeError("Pending input changed before consumption")
        return self.command("consume:" + assignment + ":" + request, {"command": "consume_input", "assignmentId": assignment, "nativeRequestId": request, "inputDigest": value["inputDigest"], "continuationReceiptId": value["continuationReceiptId"], "continuationPersisted": True})
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binding", required=True)
    sub = parser.add_subparsers(dest="mode", required=True)
    configure = sub.add_parser("configure", help="Write only a nonsecret binding profile; OAuth consent belongs to Muse Secure Vault"); configure.add_argument("--origin", required=True)
    sub.add_parser("query", help="Read JSON from stdin; see installed instructions.md for exact envelopes")
    sub.add_parser("preflight", help="Read public OAuth metadata for the normal Muse site approval; grants no worker or readiness authority")
    sub.add_parser("status", help="Inspect bound identity and local pending command count")
    sub.add_parser("help", help="Read persistent Paperclip instructions")
    receipt = sub.add_parser("receipt", help="Inspect the original durable command without resending it"); receipt.add_argument("--key", required=True)
    mailbox = sub.add_parser("mailbox", help="Durably save mailbox references; explicitly acknowledge only after incorporating them"); mailbox.add_argument("--ack", type=int)
    command = sub.add_parser("command"); command.add_argument("--key", required=True)
    for name in ("answer", "consume-input"):
        child = sub.add_parser(name); child.add_argument("assignment"); child.add_argument("request")
    cleanup = sub.add_parser("cleanup"); cleanup_mode = cleanup.add_mutually_exclusive_group()
    cleanup_mode.add_argument("--inspect", action="store_true")
    cleanup_mode.add_argument("--detector-removed", action="store_true", help="Report only an independently runtime-confirmed exact hook removal")
    cleanup_mode.add_argument("--detector-removal-requested", action="store_true", help="Report a runtime removal request; this never confirms removal")
    client = Client(parser.parse_args().binding)
    try:
        args = parser.parse_args()
        if args.mode == "configure": result = client.configure(args.origin)
        elif args.mode == "help":
            print((ROOT / "instructions.md").read_text()); return
        elif args.mode == "preflight": result = public_preflight(client.config["origin"])
        elif args.mode == "status": result = client.status()
        elif args.mode == "receipt": result = client.receipt(args.key)
        elif args.mode == "mailbox": result = client.mailbox(args.ack)
        elif args.mode == "query":
            value = json.load(sys.stdin)
            result = client.mailbox() if value.get("query") == "mailbox" else client.query(value)
        elif args.mode == "command": result = client.command(args.key, json.load(sys.stdin))
        elif args.mode == "answer": result = client.answer(args.assignment, args.request)
        elif args.mode == "consume-input": result = client.consume(args.assignment, args.request)
        elif args.mode == "cleanup" and (args.detector_removed or args.detector_removal_requested):
            result = client.detector_cleanup(args.detector_removed)
        elif args.mode == "cleanup":
            body = {"version": 1, "command": "control.inspect"} if args.inspect else {"version": 1, **json.load(sys.stdin)}
            result = http(client.config["origin"] + "/api/muse/v1/cleanup", body, client.credential_name())
        print(json.dumps(result, ensure_ascii=False))
    finally: client.close()
if __name__ == "__main__":
    try: main()
    except Exception as error:
        # Never echo exception payloads, request bodies, credentials or URLs.
        print("Paperclip client stopped: " + (str(error) if isinstance(error, RuntimeError) else "private state or transport failure"), file=sys.stderr)
        sys.exit(1)
