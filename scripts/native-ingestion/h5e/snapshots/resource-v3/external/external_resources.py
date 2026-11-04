#!/usr/bin/env python3
"""Bounded, opt-in Linux resource observation. Importing this file performs no I/O."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

SCHEMA = "native-ingestion-external-resources/v1"
ROLES = {"runner", "provider", "app-child", "diagnostic-observer"}
HEX = re.compile(r"^[0-9a-f]{64}$")


def require(value, message):
    if not value:
        raise ValueError(message)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_stat(raw):
    """Linux stat fields; comm may contain spaces or closing parentheses."""
    opening, closing = raw.find("("), raw.rfind(")")
    require(opening > 0 and closing > opening, "malformed proc stat")
    pid = int(raw[:opening].strip())
    fields = raw[closing + 1:].split()
    require(len(fields) >= 22, "short proc stat")
    result = {"pid": pid, "state": fields[0], "ppid": int(fields[1]),
              "pgid": int(fields[2]), "userTicks": int(fields[11]),
              "systemTicks": int(fields[12]), "starttimeTicks": fields[19],
              "rssPages": int(fields[21])}
    require(result["starttimeTicks"].isdigit(), "invalid birth ticks")
    require(min(result["userTicks"], result["systemTicks"]) >= 0, "negative cpu ticks")
    return result


def identity(row):
    return f'{row["pid"]}:{row["starttimeTicks"]}'


def validate_config(config):
    require(config.get("schema") == "native-ingestion-external-config/v1", "wrong config schema")
    require(re.fullmatch(r"[a-zA-Z0-9_-]{8,96}", config.get("nonce", "")), "invalid nonce")
    require(100 <= config.get("intervalMs", 0) <= 2000, "interval must be 100..2000ms")
    require(1000 <= config.get("maxDurationMs", 0) <= 1800000, "duration must be 1s..30min")
    require(1 <= config.get("maxOwnedProcesses", 0) <= 2048, "invalid owned-process cap")
    require(1 <= config.get("maxScanProcesses", 0) <= 65536, "invalid scan cap")
    require(4096 <= config.get("maxOutputBytes", 0) <= 64 * 1024 * 1024, "invalid output cap")
    require(config.get("diagnosticOnly") is True, "diagnostic-only required")
    require(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                         config.get("expectedBootId", "")), "host boot identity required")
    roots = config.get("roots", [])
    require({r.get("role") for r in roots} == {"server-node", "postgres-postmaster"}
            and len(roots) == 2, "two distinct owned roots required")
    require(len({r.get("pid") for r in roots}) == 2, "duplicate root PID")
    for root in roots:
        require(isinstance(root.get("pid"), int) and root["pid"] > 1, "invalid root PID")
        require(str(root.get("starttimeTicks", "")).isdigit(), "root birth required")
        require(isinstance(root.get("starttimeTicks"), str), "birth must be a decimal string")
        require(HEX.fullmatch(root.get("exeSha256", "")), "root executable hash required")
    require(HEX.fullmatch(config.get("owningReleaseSha256", "")), "owning release hash required")
    require(HEX.fullmatch(config.get("qualifiedBuildSha256", "")), "build qualification hash required")
    require(HEX.fullmatch(config.get("counterDefinitionsSha256", "")), "counter definitions hash required")
    for digest in config.get("runnerExecutableSha256", []):
        require(HEX.fullmatch(digest), "invalid Runner executable hash")
    for scope in config.get("cgroups", []):
        path = Path(scope.get("path", ""))
        require(path.is_absolute() and str(path).startswith("/sys/fs/cgroup/")
                and ".." not in path.parts, "cgroup path must be a dedicated child of /sys/fs/cgroup")
        require(scope.get("role") in {"app-tree", "postgres-cluster"}, "invalid cgroup role")
        require(isinstance(scope.get("inode"), int) and scope["inode"] > 0, "cgroup inode required")
        require(HEX.fullmatch(scope.get("qualificationReceiptSha256", "")), "cgroup membership/epoch receipt required")
    require(len({r["role"] for r in config.get("cgroups", [])}) == len(config.get("cgroups", [])),
            "duplicate cgroup role")
    require(len({r["path"] for r in config.get("cgroups", [])}) == len(config.get("cgroups", [])),
            "cgroup scopes must be distinct")
    return config


def read_registry(path, previous=None):
    raw = Path(path).read_bytes()
    require(len(raw) <= 1024 * 1024, "identity registry exceeds 1MiB")
    registry = json.loads(raw)
    require(registry.get("schema") == "native-ingestion-process-registry/v1", "wrong registry schema")
    require(re.fullmatch(r"[a-zA-Z0-9_-]{8,96}", registry.get("nonce", "")), "registry nonce required")
    require(isinstance(registry.get("sequence"), int) and registry["sequence"] >= 0, "invalid registry sequence")
    rows = registry.get("identities", [])
    require(len(rows) <= 2048, "registry identity cap exceeded")
    indexed = {}
    for row in rows:
        require(row.get("role") in ROLES and isinstance(row.get("pid"), int) and row["pid"] > 1,
                "invalid registry role/PID")
        require(isinstance(row.get("starttimeTicks"), str) and row["starttimeTicks"].isdigit(), "registry birth required")
        require(HEX.fullmatch(row.get("exeSha256", "")), "registry executable hash required")
        require(re.fullmatch(r"[0-9]+:[0-9]+", row.get("rootIdentity", "")), "registry root identity required")
        require(HEX.fullmatch(row.get("provenanceSha256", "")), "registry source proof hash required")
        key = identity(row)
        require(key not in indexed, "duplicate registry identity")
        indexed[key] = row
    if previous:
        require(registry["nonce"] == previous["nonce"], "registry nonce changed")
        require(registry["sequence"] >= previous["sequence"], "registry sequence rolled back")
        for key, row in previous["indexed"].items():
            require(indexed.get(key) == row, "registry removed or changed a prior identity")
    return {"nonce": registry["nonce"], "sequence": registry["sequence"],
            "sha256": hashlib.sha256(raw).hexdigest(), "indexed": indexed}


def owner_for(pid, stats, roots):
    visited = set()
    while pid in stats and pid not in visited:
        if pid in roots:
            return roots[pid]
        visited.add(pid)
        pid = stats[pid]["ppid"]
    return None


def scan_processes(config, registry, proc_root=Path("/proc"), page_size=4096, hash_cache=None):
    hash_cache = {} if hash_cache is None else hash_cache
    candidates = sorted(int(p.name) for p in proc_root.iterdir() if p.name.isdecimal())
    require(len(candidates) <= config["maxScanProcesses"], "system process scan cap exceeded")
    stats, races = {}, []
    for pid in candidates:
        try:
            stats[pid] = parse_stat((proc_root / str(pid) / "stat").read_text())
        except (FileNotFoundError, ProcessLookupError):
            races.append(pid)
    roots = {r["pid"]: r for r in config["roots"]}
    for pid, root in roots.items():
        require(pid in stats and identity(stats[pid]) == identity(root), "owned root missing or PID reused")
    root_by_identity = {identity(root): root for root in roots.values()}
    owned = []
    for pid, row in stats.items():
        root = owner_for(pid, stats, roots)
        known = registry["indexed"].get(identity(row))
        if known:
            registered_root = root_by_identity.get(known["rootIdentity"])
            require(registered_root and registered_root["role"] == "server-node", "registry root is not owned app")
            require(not root or identity(root) == identity(registered_root), "registry contradicts live ancestry")
            root = registered_root
        owned.append((pid, root))
    owned = [(pid, root) for pid, root in owned if root]
    require(len(owned) <= config["maxOwnedProcesses"], "owned process cap exceeded")
    output = []
    for pid, root in owned:
        before = stats[pid]
        try:
            executable = proc_root / str(pid) / "exe"
            metadata = executable.stat()
            fingerprint = (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns)
            if fingerprint not in hash_cache:
                require(len(hash_cache) < 128, "executable cache cap exceeded")
                hash_cache[fingerprint] = sha256(executable)
            digest = hash_cache[fingerprint]
            after = parse_stat((proc_root / str(pid) / "stat").read_text())
            after_exe = executable.stat()
            require(fingerprint == (after_exe.st_dev, after_exe.st_ino, after_exe.st_size, after_exe.st_mtime_ns),
                    "process executed a different image during snapshot")
        except (FileNotFoundError, ProcessLookupError):
            races.append(pid)
            continue
        require(identity(before) == identity(after), "PID reused within process read")
        key = identity(after)
        known = registry["indexed"].get(key)
        if pid in roots:
            role = root["role"]
            require(digest == root["exeSha256"], "root executable changed")
        elif known:
            role = known["role"]
            require(digest == known["exeSha256"], "registered executable changed")
            require(root["role"] == "server-node", "non-application registry identity")
        elif root["role"] == "postgres-postmaster":
            role = "postgres-process"
        elif digest in config.get("runnerExecutableSha256", []):
            role = "runner"
        else:
            role = "app-child-unclassified"
        output.append({**after, "role": role, "rootIdentity": identity(root),
                       "exeSha256": digest, "rssBytes": max(0, after["rssPages"]) * page_size,
                       "ownershipEvidence": "registered-lifecycle" if known else "live-parent-chain"})
    require(all(any(identity(row) == identity(root) for row in output) for root in roots.values()),
            "owned root exited during snapshot")
    return {"processes": sorted(output, key=lambda r: (r["pid"], r["starttimeTicks"])),
            "scanRaces": sorted(set(races)), "scanCandidateCount": len(candidates),
            "unclassifiedOwnedCount": sum(r["role"] == "app-child-unclassified" for r in output)}


def parse_key_values(raw):
    values = {}
    for line in raw.splitlines():
        key, value = line.split()
        require(key not in values and value.isdigit(), "invalid counter file")
        values[key] = int(value)
    return values


def sample_cgroup(scope, owned, proc_root=Path("/proc")):
    path = Path(scope["path"])
    require(path.resolve() == path and path.stat().st_ino == scope["inode"], "cgroup path/inode changed")
    require((Path("/sys/fs/cgroup") / "cgroup.controllers").is_file(), "cgroup v2 required")
    directories = [path]
    for directory in directories:
        directories.extend(p for p in directory.iterdir() if p.is_dir() and not p.is_symlink())
        require(len(directories) <= 64, "cgroup descendant cap exceeded")
    members = set()
    for directory in directories:
        for value in (directory / "cgroup.procs").read_text().split():
            require(value.isdigit(), "invalid cgroup member")
            members.add(int(value))
            require(len(members) <= 2048, "cgroup member cap exceeded")
    cpu = parse_key_values((path / "cpu.stat").read_text())
    require(all(k in cpu for k in ["usage_usec", "user_usec", "system_usec"]), "missing cgroup CPU counters")
    expected_root = "server-node" if scope["role"] == "app-tree" else "postgres-postmaster"
    owned_by_pid = {row["pid"]: row for row in owned if row["rootIdentity"] ==
                    next(row["rootIdentity"] for row in owned if row["role"] == expected_root)}
    unexpected = sorted(members - owned_by_pid.keys())
    escaped = sorted(owned_by_pid.keys() - members)
    changed_birth = []
    for pid in members & owned_by_pid.keys():
        try:
            current = parse_stat((proc_root / str(pid) / "stat").read_text())
            if identity(current) != identity(owned_by_pid[pid]):
                changed_birth.append(pid)
        except (FileNotFoundError, ProcessLookupError):
            changed_birth.append(pid)
    # Membership snapshots race with fork/exit. Preserve mismatches; never silently qualify them.
    return {"role": scope["role"], "inode": scope["inode"],
            "qualificationReceiptSha256": scope["qualificationReceiptSha256"],
            "cpu": cpu, "memoryCurrentBytes": int((path / "memory.current").read_text()),
            "memoryPeakBytes": int((path / "memory.peak").read_text()) if (path / "memory.peak").exists() else None,
            "memberCount": len(members), "unexpectedPids": unexpected, "escapedPids": escaped,
            "membershipBirthMismatches": changed_birth,
            "membershipSnapshotConsistent": not unexpected and not escaped and not changed_birth}


def validate_timeline(samples):
    require(bool(samples), "empty sample timeline")
    origin_wall = samples[0]["beginEpochMs"]
    origin_mono = int(samples[0]["monotonicNs"])
    previous_end = None
    for row in samples:
        require(row["beginEpochMs"] <= row["endEpochMs"], "negative snapshot span")
        require(previous_end is None or row["beginEpochMs"] >= previous_end, "overlapping/reordered snapshots")
        residual_ms = row["beginEpochMs"] - origin_wall - (int(row["monotonicNs"]) - origin_mono) / 1e6
        require(abs(residual_ms) <= 2, "wall/monotonic clock discontinuity exceeds 2ms")
        previous_end = row["endEpochMs"]


def observed_cpu_lower_bound(samples, start_ms, end_ms, role, clock_ticks):
    """Only matching-PID deltas wholly inside the window; not a full-tree CPU estimate."""
    require(start_ms < end_ms and clock_ticks > 0, "invalid window or CLK_TCK")
    validate_timeline(samples)
    interior = [s for s in samples if s["beginEpochMs"] >= start_ms and s["endEpochMs"] <= end_ms]
    ticks, intervals, lost = 0, 0, 0
    for first, second in zip(interior, interior[1:]):
        left = {identity(r): r for r in first["processes"] if r["role"] == role}
        right = {identity(r): r for r in second["processes"] if r["role"] == role}
        for key in left.keys() & right.keys():
            delta = sum(right[key][k] - left[key][k] for k in ["userTicks", "systemTicks"])
            require(delta >= 0, "CPU counter decreased")
            ticks += delta
        lost += len(left.keys() ^ right.keys())
        intervals += 1
    return {"role": role, "observedCpuMsLowerBound": ticks * 1000 / clock_ticks,
            "upperBoundMs": None, "interiorIntervals": intervals,
            "identityBoundaryChanges": lost, "fullPopulationCpuPerEventEligible": False,
            "reason": "short-lived processes and unobserved exit ticks remain unbounded"}


def cgroup_cpu_bounds(samples, start_ms, end_ms, role):
    """Brackets from whole-snapshot read spans, conditional on separate scope qualification."""
    require(start_ms < end_ms, "invalid window")
    validate_timeline(samples)
    before = [s for s in samples if s["endEpochMs"] < start_ms]
    after = [s for s in samples if s["beginEpochMs"] > end_ms]
    inside = [s for s in samples if s["beginEpochMs"] >= start_ms and s["endEpochMs"] <= end_ms]
    require(before and after and len(inside) >= 6, "need bracketing samples and five interior intervals")
    chosen = [before[-1], *inside, after[0]]
    rows = []
    for sample in chosen:
        matches = [r for r in sample["cgroups"] if r["role"] == role]
        require(len(matches) == 1 and matches[0]["membershipSnapshotConsistent"], "invalid membership snapshot")
        rows.append(matches[0])
    require(len({(r["inode"], r["qualificationReceiptSha256"]) for r in rows}) == 1,
            "scope identity/qualification changed")
    values = [r["cpu"]["usage_usec"] for r in rows]
    require(values == sorted(values), "cgroup CPU counter reset")
    upper = values[-1] - values[0]
    lower = values[-2] - values[1]
    require(upper > 0 and 0 <= lower <= upper, "invalid CPU bounds")
    uncertainty = (upper - lower) / upper
    return {"role": role, "lowerCpuMs": lower / 1000, "upperCpuMs": upper / 1000,
            "boundaryUncertainty": uncertainty, "boundaryEligible": uncertainty <= .10,
            "interiorIntervals": len(inside) - 1,
            "qualificationReceiptSha256": rows[0]["qualificationReceiptSha256"],
            "includesDatabaseObserverOverhead": role == "postgres-cluster",
            "separateScopeEpochMembershipAndOwningOutcomeProofRequired": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--registry", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--stop-file", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    config_raw = Path(args.config).read_bytes()
    config = validate_config(json.loads(config_raw))
    registry = read_registry(args.registry)
    require(registry["nonce"] == config["nonce"], "registry nonce mismatch")
    output = Path(args.output)
    stop_file = Path(args.stop_file)
    require(not output.exists() and not Path(str(output) + ".receipt.json").exists(), "output already exists")
    require(not stop_file.exists(), "stop marker already exists")
    if not args.execute:
        print(json.dumps({"validSourceConfig": True, "executed": False, "diagnosticOnly": True}))
        return
    require(sys.platform == "linux", "Linux only")
    require(Path("/proc/sys/kernel/random/boot_id").read_text().strip() == config["expectedBootId"],
            "host boot identity changed")
    started_mono = time.monotonic_ns()
    started_cpu = time.process_time_ns()
    clock_ticks, page_size = os.sysconf("SC_CLK_TCK"), os.sysconf("SC_PAGE_SIZE")
    output.parent.mkdir(parents=True, exist_ok=True)
    digest, written, count = hashlib.sha256(), 0, 0
    completed, error_code, hash_cache = False, None, {}
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
        def write(record):
            nonlocal written
            raw = (json.dumps(record, separators=(",", ":")) + "\n").encode()
            require(written + len(raw) <= config["maxOutputBytes"], "output byte cap exceeded")
            stream.write(raw)
            digest.update(raw)
            written += len(raw)
        write({"schema": SCHEMA, "kind": "header", "diagnosticOnly": True,
               "configSha256": hashlib.sha256(config_raw).hexdigest(), "config": config,
               "samplerSha256": sha256(__file__), "clockTicksPerSecond": clock_ticks,
               "pageSize": page_size, "samplerPid": os.getpid(), "epochMs": time.time_ns() / 1e6})
        try:
            while True:
                begin_epoch, begin_mono = time.time_ns() / 1e6, time.monotonic_ns()
                registry = read_registry(args.registry, registry)
                require(registry["nonce"] == config["nonce"], "registry nonce mismatch")
                processes = scan_processes(config, registry, page_size=page_size, hash_cache=hash_cache)
                groups = [sample_cgroup(scope, processes["processes"]) for scope in config.get("cgroups", [])]
                write({"kind": "sample", "beginEpochMs": begin_epoch,
                       "endEpochMs": time.time_ns() / 1e6, "monotonicNs": str(begin_mono),
                       "readDurationMs": (time.monotonic_ns() - begin_mono) / 1e6,
                       "registrySequence": registry["sequence"], "registrySha256": registry["sha256"],
                       **processes, "cgroups": groups})
                count += 1
                if stop_file.exists():
                    marker = json.loads(stop_file.read_bytes())
                    require(marker == {"schema": "native-ingestion-resource-stop/v1", "nonce": config["nonce"]},
                            "invalid stop marker")
                    completed = True
                    break
                elapsed = (time.monotonic_ns() - started_mono) / 1e6
                require(elapsed < config["maxDurationMs"], "resource deadline reached without final stop marker")
                time.sleep(max(0, config["intervalMs"] / 1000 - (time.monotonic_ns() - begin_mono) / 1e9))
        except Exception as error:
            error_code = type(error).__name__
            # Fixed error class only: no paths, arbitrary exception values, command line or environment.
            try:
                write({"kind": "failed", "errorClass": error_code, "epochMs": time.time_ns() / 1e6})
            except ValueError:
                pass
        stream.flush()
        os.fsync(stream.fileno())
    receipt = {"schema": SCHEMA, "diagnosticOnly": True, "completed": completed,
               "errorClass": error_code, "sampleCount": count, "bytes": written,
               "sha256": digest.hexdigest(), "elapsedMs": (time.monotonic_ns() - started_mono) / 1e6,
               "samplerCpuMs": (time.process_time_ns() - started_cpu) / 1e6,
               "cpuPerEventClaim": False}
    receipt_path = Path(str(output) + ".receipt.json")
    with os.fdopen(os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(json.dumps(receipt, indent=2) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps(receipt))
    if not completed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
