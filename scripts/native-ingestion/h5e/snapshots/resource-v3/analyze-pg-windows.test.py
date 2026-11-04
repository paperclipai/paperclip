import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('pg_windows', Path(__file__).with_name('analyze-pg-windows.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def evidence():
    return {'complete': True, 'observationComplete': True, 'diagnosticOnly': True,
            'performanceAcceptanceEligible': False, 'qualificationOnly': False,
            'cases': [{'name': 'loaded', 'stop': False, 'runs': 10, 'events': 128,
                       'durable': [{'individualDeltas': 128} for _ in range(10)],
                       'epochMs': 500, 'settledAtMs': 7500,
                       'h5': {'independentDrain': {'verifiedAtMs': 7501}}}, {'stop': True}]}


def samples():
    return [{'kind': 'sample', 'beginEpochMs': i * 1000, 'endEpochMs': i * 1000 + 1,
             'monotonicNs': str(i * 1000000000), 'cgroups': [{
                 'role': 'postgres-cluster', 'inode': 5, 'qualificationReceiptSha256': 'a' * 64,
                 'membershipSnapshotConsistent': True,
                 'cpu': {'usage_usec': max(0, min(600000, (i - 1) * 100000))}}]} for i in range(10)]


class WindowTests(unittest.TestCase):
    def test_complete_cpu_brackets_have_exact_denominator_and_distinct_boundaries(self):
        rows = module.analyze(evidence(), samples())
        self.assertEqual(len(rows), 2)
        self.assertEqual([r['boundary'] for r in rows], ['terminal', 'fully-verified'])
        for row in rows:
            self.assertEqual(row['denominator'], 1280)
            self.assertTrue(row['pgClusterCpu']['boundaryEligible'])
            self.assertEqual(row['pgClusterCpu']['lowerCpuMsPerDurableTextDelta'], 600 / 1280)
            self.assertFalse(row['shutdownCpuIncluded'])

    def test_partial_small_or_wrong_committed_counts_never_supply_ratios(self):
        for key, value in [('complete', False), ('qualificationOnly', True), ('observationComplete', False)]:
            bad = evidence(); bad[key] = value
            with self.assertRaises(AssertionError): module.analyze(bad, samples())
        bad = evidence(); bad['cases'][0]['durable'][0]['individualDeltas'] = 127
        with self.assertRaises(AssertionError): module.analyze(bad, samples())

    def test_short_uncertain_or_changed_scope_windows_remain_ineligible(self):
        bad = evidence(); bad['cases'][0]['settledAtMs'] = 2500
        self.assertFalse(module.analyze(bad, samples())[0]['pgClusterCpu']['boundaryEligible'])
        for mutate in [lambda rows: rows[3]['cgroups'][0].update(membershipSnapshotConsistent=False),
                       lambda rows: rows[3]['cgroups'][0].update(inode=6),
                       lambda rows: rows[3].update(monotonicNs='100000000000')]:
            rows = samples(); mutate(rows)
            result = module.analyze(evidence(), rows)
            for row in result:
                self.assertFalse(row['pgClusterCpu']['boundaryEligible'])
                self.assertNotIn('lowerCpuMsPerDurableTextDelta', row['pgClusterCpu'])
        rows = samples(); rows[-2]['cgroups'][0]['cpu']['usage_usec'] = 900000
        rows[-1]['cgroups'][0]['cpu']['usage_usec'] = 900000
        self.assertFalse(module.analyze(evidence(), rows)[0]['pgClusterCpu']['boundaryEligible'])


if __name__ == '__main__': unittest.main()
