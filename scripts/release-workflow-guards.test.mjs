import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readWorkflow(name) {
  return readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
}

function jobBlock(workflow, jobName, nextJobName) {
  const jobsStart = workflow.indexOf('\njobs:\n');
  assert.notEqual(jobsStart, -1, 'missing jobs block');
  const start = workflow.indexOf(`\n  ${jobName}:`, jobsStart);
  assert.notEqual(start, -1, `missing ${jobName} job`);
  if (!nextJobName) {
    return workflow.slice(start);
  }
  const end = workflow.indexOf(`\n  ${nextJobName}:`, start + 1);
  assert.notEqual(end, -1, `missing ${nextJobName} job after ${jobName}`);
  return workflow.slice(start, end);
}

test('Docker workflow does not publish images on routine master pushes', () => {
  const docker = readWorkflow('docker.yml');

  assert.match(docker, /on:\n  push:\n    tags:\n      - "v\*"/);
  assert.doesNotMatch(docker, /push:[\s\S]*?branches:[\s\S]*?master/);
  assert.match(docker, /workflow_dispatch:/);
  assert.match(docker, /environment: docker-release/);
  assert.match(docker, /source_ref:/);
  assert.match(docker, /publish_latest:/);
  assert.match(
    docker,
    /type=raw,value=latest,enable=\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.publish_latest \}\}/,
  );
});

test('Release workflow keeps push-to-master verification but gates npm publishing to manual dispatch', () => {
  const release = readWorkflow('release.yml');
  const publishCanary = jobBlock(release, 'publish_canary', 'verify_stable');

  assert.match(release, /verify_canary:[\s\S]*github\.event_name == 'push'/);
  assert.match(release, /publish_canary_skipped:[\s\S]*if: github\.event_name == 'push'/);
  assert.match(
    publishCanary,
    /if: github\.event_name == 'workflow_dispatch' && inputs\.publish_canary == true/,
  );
  assert.doesNotMatch(publishCanary, /github\.event_name == 'push'/);
  assert.doesNotMatch(release, /ENABLE_NPM_CANARY_PUBLISH/);
});
