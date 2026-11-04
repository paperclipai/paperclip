import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("external_resources", Path(__file__).with_name("external_resources.py"))
resource = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(resource)
HASH = "a" * 64


def proc_stat(pid, ppid, birth, user=10, system=5, rss=2):
    fields = ["S", str(ppid), str(pid), "0", "0", "0", "0", "0", "0", "0", "0",
              str(user), str(system), "0", "0", "0", "0", "0", "0", str(birth), "0", str(rss)]
    return f'{pid} (worker ) name) ' + " ".join(fields)


def config():
    return {"schema": "native-ingestion-external-config/v1", "diagnosticOnly": True,
            "nonce": "pure_test_nonce", "intervalMs": 1000, "maxDurationMs": 1800000,
            "expectedBootId": "00000000-0000-4000-8000-000000000001",
            "maxOwnedProcesses": 2048, "maxScanProcesses": 65536, "maxOutputBytes": 64 * 1024 * 1024,
            "owningReleaseSha256": HASH, "qualifiedBuildSha256": HASH, "counterDefinitionsSha256": HASH,
            "roots": [{"role": "server-node", "pid": 100, "starttimeTicks": "50", "exeSha256": HASH},
                      {"role": "postgres-postmaster", "pid": 200, "starttimeTicks": "60", "exeSha256": HASH}],
            "runnerExecutableSha256": [], "cgroups": []}


def make_proc(directory, pid, ppid, birth, content=b"executable"):
    path = directory / str(pid)
    path.mkdir()
    (path / "stat").write_text(proc_stat(pid, ppid, birth))
    (path / "exe").write_bytes(content)
    return resource.sha256(path / "exe")


def sample(at, value, consistent=True):
    return {"beginEpochMs": at - .1, "endEpochMs": at + .1,
            "monotonicNs": str(round((at + 100) * 1000000)),
            "processes": [{"pid": 100, "starttimeTicks": "50", "role": "server-node",
                           "userTicks": value, "systemTicks": 0}],
            "cgroups": [{"role": "postgres-cluster", "inode": 42,
                         "qualificationReceiptSha256": HASH, "membershipSnapshotConsistent": consistent,
                         "cpu": {"usage_usec": value * 1000}}]}


class ResourceTests(unittest.TestCase):
    def test_stat_handles_spaces_and_parentheses_without_child_cpu(self):
        result = resource.parse_stat(proc_stat(100, 4, 12345678901234567890, 7, 3, 11))
        self.assertEqual(result["starttimeTicks"], "12345678901234567890")
        self.assertEqual((result["userTicks"], result["systemTicks"], result["rssPages"]), (7, 3, 11))

    def test_malformed_stat_fails(self):
        with self.assertRaises(ValueError):
            resource.parse_stat("100 bad")

    def test_config_requires_two_birth_pinned_roots(self):
        candidate = config()
        resource.validate_config(candidate)
        candidate["roots"][1]["pid"] = 100
        with self.assertRaises(ValueError):
            resource.validate_config(candidate)

    def test_unbounded_duration_rejected(self):
        candidate = config()
        candidate["maxDurationMs"] += 1
        with self.assertRaises(ValueError):
            resource.validate_config(candidate)

    def test_cgroup_needs_dedicated_path_and_epoch_proof(self):
        candidate = config()
        candidate["cgroups"] = [{"role": "postgres-cluster", "path": "/sys/fs/cgroup",
                                 "inode": 42, "qualificationReceiptSha256": HASH}]
        with self.assertRaises(ValueError):
            resource.validate_config(candidate)

    def test_cyclic_parent_chain_does_not_claim_process(self):
        self.assertIsNone(resource.owner_for(1, {1: {"ppid": 2}, 2: {"ppid": 1}}, {}))

    def test_fake_proc_descendants_and_known_provider(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            digest = make_proc(directory, 100, 1, 50)
            make_proc(directory, 200, 1, 60)
            make_proc(directory, 101, 100, 51)
            make_proc(directory, 102, 101, 52)
            make_proc(directory, 201, 200, 61)
            make_proc(directory, 999, 1, 1)
            candidate = config()
            for root in candidate["roots"]:
                root["exeSha256"] = digest
            registry = {"indexed": {"102:52": {"pid": 102, "starttimeTicks": "52", "role": "provider",
                        "exeSha256": digest, "rootIdentity": "100:50", "provenanceSha256": HASH}}}
            result = resource.scan_processes(candidate, registry, directory)
            self.assertEqual({r["pid"] for r in result["processes"]}, {100, 101, 102, 200, 201})
            self.assertEqual(next(r["role"] for r in result["processes"] if r["pid"] == 102), "provider")
            self.assertEqual(result["unclassifiedOwnedCount"], 1)

    def test_registered_orphan_stays_bound_to_original_root(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            digest = make_proc(directory, 100, 1, 50)
            make_proc(directory, 200, 1, 60)
            make_proc(directory, 102, 1, 52)
            candidate = config()
            for root in candidate["roots"]:
                root["exeSha256"] = digest
            registry = {"indexed": {"102:52": {"pid": 102, "starttimeTicks": "52", "role": "provider",
                        "exeSha256": digest, "rootIdentity": "100:50", "provenanceSha256": HASH}}}
            result = resource.scan_processes(candidate, registry, directory)
            self.assertEqual(next(r["ownershipEvidence"] for r in result["processes"] if r["pid"] == 102),
                             "registered-lifecycle")

    def test_reused_root_pid_fails_before_cost_attribution(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            make_proc(directory, 100, 1, 999)
            make_proc(directory, 200, 1, 60)
            with self.assertRaisesRegex(ValueError, "PID reused"):
                resource.scan_processes(config(), {"indexed": {}}, directory)

    def test_executable_hash_mismatch_fails(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            make_proc(directory, 100, 1, 50)
            make_proc(directory, 200, 1, 60)
            with self.assertRaisesRegex(ValueError, "executable changed"):
                resource.scan_processes(config(), {"indexed": {}}, directory)

    def test_same_birth_exec_change_during_snapshot_fails(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            digest = make_proc(directory, 100, 1, 50)
            make_proc(directory, 200, 1, 60)
            candidate = config()
            for root in candidate["roots"]:
                root["exeSha256"] = digest
            original = resource.sha256
            def replacement(path):
                result = original(path)
                path.write_bytes(b"a different executable image")
                return result
            with patch.object(resource, "sha256", replacement):
                with self.assertRaisesRegex(ValueError, "different image"):
                    resource.scan_processes(candidate, {"indexed": {}}, directory)

    def test_registry_is_append_only_and_birth_bound(self):
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "registry.json"
            row = {"pid": 102, "starttimeTicks": "52", "role": "provider", "exeSha256": HASH,
                   "rootIdentity": "100:50", "provenanceSha256": HASH}
            path.write_text(json.dumps({"schema": "native-ingestion-process-registry/v1", "nonce": "pure_test_nonce", "sequence": 1,
                                        "identities": [row]}))
            previous = resource.read_registry(path)
            path.write_text(json.dumps({"schema": "native-ingestion-process-registry/v1", "nonce": "pure_test_nonce", "sequence": 2,
                                        "identities": []}))
            with self.assertRaisesRegex(ValueError, "removed"):
                resource.read_registry(path, previous)

    def test_proc_cpu_never_promotes_observed_ticks_to_full_population(self):
        result = resource.observed_cpu_lower_bound([sample(at, at) for at in range(10)], 1, 8, "server-node", 100)
        self.assertEqual(result["observedCpuMsLowerBound"], 50)
        self.assertIsNone(result["upperBoundMs"])
        self.assertFalse(result["fullPopulationCpuPerEventEligible"])

    def test_cgroup_boundary_uncertainty_rejects_small_windows(self):
        result = resource.cgroup_cpu_bounds([sample(at, at + 1) for at in range(10)], 1, 8, "postgres-cluster")
        self.assertEqual(result["interiorIntervals"], 5)
        self.assertFalse(result["boundaryEligible"])
        self.assertGreater(result["boundaryUncertainty"], .1)

    def test_cgroup_boundary_bounds_accept_only_sufficient_brackets(self):
        records = [sample(0, 0), *[sample(i, 2 + (i - 1) * 100) for i in range(1, 8)], sample(8, 604)]
        result = resource.cgroup_cpu_bounds(records, .5, 7.5, "postgres-cluster")
        self.assertTrue(result["boundaryEligible"])
        self.assertEqual((result["lowerCpuMs"], result["upperCpuMs"]), (600, 604))
        self.assertTrue(result["separateScopeEpochMembershipAndOwningOutcomeProofRequired"])

    def test_cgroup_membership_mismatch_and_reset_fail(self):
        records = [sample(at, at + 1) for at in range(10)]
        records[4]["cgroups"][0]["membershipSnapshotConsistent"] = False
        with self.assertRaisesRegex(ValueError, "membership"):
            resource.cgroup_cpu_bounds(records, 1, 8, "postgres-cluster")
        records[4]["cgroups"][0]["membershipSnapshotConsistent"] = True
        records[4]["cgroups"][0]["cpu"]["usage_usec"] = 0
        with self.assertRaisesRegex(ValueError, "reset"):
            resource.cgroup_cpu_bounds(records, 1, 8, "postgres-cluster")

    def test_wall_clock_jump_cannot_create_valid_cpu_bounds(self):
        records = [sample(at, at + 1) for at in range(10)]
        records[-1]["monotonicNs"] = "0"
        with self.assertRaisesRegex(ValueError, "discontinuity"):
            resource.cgroup_cpu_bounds(records, 1, 8, "postgres-cluster")

    def test_exited_identity_never_contributes_unobserved_final_ticks(self):
        records = [sample(at, at) for at in range(10)]
        records[4]["processes"] = []
        result = resource.observed_cpu_lower_bound(records, 1, 8, "server-node", 100)
        self.assertEqual(result["observedCpuMsLowerBound"], 30)
        self.assertEqual(result["identityBoundaryChanges"], 2)
        self.assertIsNone(result["upperBoundMs"])


if __name__ == "__main__":
    unittest.main()
