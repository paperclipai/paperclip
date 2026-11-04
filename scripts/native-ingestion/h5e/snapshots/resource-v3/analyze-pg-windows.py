#!/usr/bin/env python3
"""Offline only: existing frozen bracket rules on independently sealed raw samples."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

MODULE = Path(__file__).with_name('external') / 'external_resources.py'
SPEC = importlib.util.spec_from_file_location('external_resources', MODULE)
resource = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(resource)


def analyze(evidence, rows):
    assert evidence['complete'] is True and evidence['observationComplete'] is True
    assert evidence['diagnosticOnly'] is True and evidence['performanceAcceptanceEligible'] is False
    assert evidence['qualificationOnly'] is False, 'SMALL supplies no resource ratios'
    samples = [row for row in rows if row.get('kind') == 'sample']
    result = []
    for case in evidence['cases']:
        if case['stop']:
            continue
        denominator = sum(row['individualDeltas'] for row in case['durable'])
        assert denominator == case['runs'] * case['events']
        for name, end in [('terminal', case['settledAtMs']), ('fully-verified', case['h5']['independentDrain']['verifiedAtMs'])]:
            try:
                bounds = resource.cgroup_cpu_bounds(samples, case['epochMs'], end, 'postgres-cluster')
                if bounds['boundaryEligible']:
                    bounds['lowerCpuMsPerDurableTextDelta'] = bounds['lowerCpuMs'] / denominator
                    bounds['upperCpuMsPerDurableTextDelta'] = bounds['upperCpuMs'] / denominator
            except ValueError as error:
                bounds = {'boundaryEligible': False, 'reason': str(error)}
            result.append({'case': case['name'], 'boundary': name, 'startMs': case['epochMs'], 'endMs': end,
                           'denominator': denominator, 'denominatorKind': 'independently verified durable text deltas',
                           'pgClusterCpu': bounds, 'includesMaintenanceAndSqlObserver': True,
                           'shutdownCpuIncluded': False, 'servingScopeAndOutcomeProofStillRequired': True})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['proc', 'owning', 'flush', 'coverage', 'output']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    raw = Path(args.proc).read_bytes()
    assert len(raw) <= 64 * 1024 * 1024
    flush = json.loads(Path(args.flush).read_bytes())
    assert flush['complete'] is True and flush['procReceipt']['completed'] is True
    assert hashlib.sha256(raw).hexdigest() == flush['procReceipt']['sha256']
    coverage = json.loads(Path(args.coverage).read_bytes())
    assert coverage['complete'] is True
    rows = [json.loads(line) for line in raw.splitlines()]
    assert rows[0]['diagnosticOnly'] is True
    output = {'diagnosticOnly': True, 'performanceAcceptanceEligible': False,
              'procSha256': hashlib.sha256(raw).hexdigest(), 'windows': analyze(json.loads(Path(args.owning).read_bytes()), rows),
              'limitations': 'PG aggregate includes maintenance and observer work; proc sums are not substituted. No CPU gain or unprofiled latency claim.'}
    with Path(args.output).open('x') as stream:
        json.dump(output, stream, indent=2)
        stream.write('\n')


if __name__ == '__main__':
    main()
