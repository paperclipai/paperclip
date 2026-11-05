import { H5_REGISTRATION, H5_WORKLOAD_SHA256 } from '../tests/e2e/fixtures/native-ingestion-h5.mjs';
if (process.argv.length > 2) throw new Error('Dry run only: this command accepts no execution arguments');
console.log(JSON.stringify({ dryRun: true, executionAuthorized: false, workloadSha256: H5_WORKLOAD_SHA256,
  registration: H5_REGISTRATION, requiredBeforeRelease: ['Root-reviewed exact driver/comparator hashes',
    'New functional observation qualification', 'Fresh B0 and B1 A/A before further product implementation',
    'Root-reviewed frozen A/A report hashes before candidate stages', 'Final B2 every-arm original SLA pass',
    'Later H4e default-mode full functional pass on the same source, geometry and final SUT'] }, null, 2));
