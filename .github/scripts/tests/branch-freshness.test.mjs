import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  computeFreshnessStatus,
  hasStrictFreshnessEnforcement,
  runBranchFreshness,
  successDescription,
} from '../branch-freshness.mjs'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)

function comparison(overrides = {}) {
  return {
    base_commit: { sha: base },
    behind_by: 0,
    ...overrides,
  }
}

function result(overrides = {}) {
  return computeFreshnessStatus({
    comparison: comparison(),
    protectedBase: 'master',
    observedHeadSha: head,
    observedBaseSha: base,
    liveHeadSha: head,
    liveBaseSha: base,
    ...overrides,
  })
}

function strictRuleset(overrides = {}) {
  return {
    enforcement: 'active',
    rules: [{
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{
          context: 'branch-freshness',
          integration_id: 15368,
        }],
      },
    }],
    ...overrides,
  }
}

function rulesetRequest(ruleset = strictRuleset()) {
  return async () => ({ data: ruleset })
}

test('workflow recomputes on pull request heads and protected master advances', async () => {
  const source = await readFile('.github/workflows/branch-freshness.yml', 'utf8')

  assert.match(source, /pull_request_target:/)
  assert.match(source, /types: \[opened, reopened, synchronize, ready_for_review\]/)
  assert.doesNotMatch(source, /\btype?s?:[^\n]*edited\b/)
  assert.match(source, /push:\s*\n\s*branches: \[master\]/)
  assert.match(source, /statuses: write/)
  assert.match(source, /if: github\.repository == 'paperclipai\/paperclip'/)
  const concurrency = source.match(/^concurrency:\s*\n((?: {2}[^\n]*\n)+)/m)?.[0] ?? ''
  assert.match(concurrency, /group: branch-freshness\s*$/m)
  assert.match(concurrency, /queue: max\s*$/m)
  assert.match(concurrency, /cancel-in-progress: false\s*$/m)
  assert.match(source, /persist-credentials: false/)
  const executableSource = source.match(/script: \|([\s\S]*)/)?.[1] ?? ''
  assert.doesNotMatch(executableSource, /\$\{\{\s*github\.event/)
  assert.doesNotMatch(source, /\bsecrets\s*:/)
  assert.doesNotMatch(source, /permissions:\s*[\s\S]*?contents:\s*write/)
  assert.match(source, /runBranchFreshness/)
})

test('only exact stable zero-behind evidence succeeds', () => {
  assert.deepEqual(result(), {
    state: 'success',
    description: successDescription('master', base),
    stale: false,
  })
  assert.equal(result({
    comparison: comparison({ behind_by: 1 }),
  }).state, 'failure')
})

test('success requires the exact active strict ruleset check', () => {
  const input = {
    ruleset: strictRuleset(),
    statusContext: 'branch-freshness',
    statusIntegrationId: 15368,
  }
  assert.equal(hasStrictFreshnessEnforcement(input), true)
  assert.equal(hasStrictFreshnessEnforcement({
    ...input,
    ruleset: strictRuleset({ enforcement: 'disabled' }),
  }), false)
  assert.equal(hasStrictFreshnessEnforcement({
    ...input,
    ruleset: strictRuleset({
      rules: [{
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [{ context: 'branch-freshness', integration_id: 15368 }],
        },
      }],
    }),
  }), false)
  assert.equal(hasStrictFreshnessEnforcement({
    ...input,
    statusIntegrationId: 1,
  }), false)
})

test('changed base or head makes a completed comparison stale', () => {
  assert.deepEqual(result({ liveBaseSha: 'c'.repeat(40) }), {
    state: 'error',
    description: `Comparison for protected master ${base} became stale.`,
    stale: true,
  })
  assert.equal(result({ liveHeadSha: 'd'.repeat(40) }).state, 'error')
})

test('wrong-head, wrong-base, and unavailable comparison evidence fail closed', () => {
  assert.equal(result({ liveHeadSha: 'c'.repeat(40) }).state, 'error')
  assert.equal(result({
    comparison: comparison({ base_commit: { sha: 'd'.repeat(40) } }),
  }).state, 'error')
  assert.equal(result({ comparison: null }).state, 'error')
  assert.equal(result({
    comparison: comparison({ behind_by: undefined }),
  }).state, 'error')
})

test('an unavailable protected-base lookup overwrites prior success on the event head', async () => {
  const statuses = []
  const errors = []
  let failure
  const github = {
    request: rulesetRequest(),
    rest: {
      git: {
        getRef: async () => {
          throw new Error('protected base API unavailable')
        },
      },
      pulls: {
        get: async () => ({
          data: {
            state: 'open',
            base: { ref: 'master' },
            head: { sha: head },
          },
        }),
      },
      repos: {
        createCommitStatus: async ({ sha, state, description }) => {
          statuses.push({ sha, state, description })
        },
      },
    },
  }
  const context = {
    eventName: 'pull_request_target',
    payload: { pull_request: { number: 42, head: { sha: head } } },
    repo: { owner: 'paperclipai', repo: 'paperclip' },
    runId: 1,
    serverUrl: 'https://github.com',
  }
  const core = {
    error: (message) => errors.push(message),
    setFailed: (message) => { failure = message },
  }

  await runBranchFreshness({ github, context, core })

  assert.equal(statuses[0].state, 'pending')
  assert.deepEqual(statuses.at(-1), {
    sha: head,
    state: 'error',
    description: 'Comparison with protected master is unavailable.',
  })
  assert.match(errors[0], /protected base API unavailable/)
  assert.match(failure, /comparison was unavailable or stale/)
})

test('a protected-base run marks every open head pending before comparing any head', async () => {
  const otherHead = 'c'.repeat(40)
  const statuses = []
  let firstComparisonStatusCount
  const pulls = [
    { number: 41, head: { sha: head } },
    { number: 42, head: { sha: otherHead } },
  ]
  const github = {
    request: rulesetRequest(),
    paginate: async () => pulls,
    rest: {
      git: {
        getRef: async () => ({ data: { object: { sha: base } } }),
      },
      pulls: {
        list: async () => ({ data: pulls }),
        get: async ({ pull_number: number }) => ({
          data: {
            state: 'open',
            base: { ref: 'master' },
            head: { sha: number === 41 ? head : otherHead },
          },
        }),
      },
      repos: {
        createCommitStatus: async ({ sha, state, description }) => {
          statuses.push({ sha, state, description })
        },
        compareCommitsWithBasehead: async ({ basehead }) => {
          firstComparisonStatusCount ??= statuses.length
          const comparedHead = basehead.split('...')[1]
          return {
            data: {
              base_commit: { sha: base },
              behind_by: comparedHead === head ? 0 : 1,
            },
          }
        },
      },
    },
  }
  const context = {
    eventName: 'push',
    payload: {},
    repo: { owner: 'paperclipai', repo: 'paperclip' },
    runId: 1,
    serverUrl: 'https://github.com',
  }
  const core = { error: () => {}, setFailed: () => {} }

  await runBranchFreshness({ github, context, core })

  assert.ok(firstComparisonStatusCount >= pulls.length)
  assert.deepEqual(statuses.slice(0, 2).map(({ sha, state }) => ({ sha, state })), [
    { sha: head, state: 'pending' },
    { sha: otherHead, state: 'pending' },
  ])
  assert.equal(statuses.at(-1).state, 'failure')
})

test('a REST enumeration failure falls back and invalidates GraphQL heads', async () => {
  const statuses = []
  const warnings = []
  const github = {
    request: rulesetRequest(),
    paginate: async () => {
      throw new Error('REST pull API unavailable')
    },
    graphql: async () => ({
      repository: {
        pullRequests: {
          nodes: [{ number: 42, baseRefName: 'master', headRefOid: head }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }),
    rest: {
      git: { getRef: async () => ({ data: { object: { sha: base } } }) },
      pulls: {
        list: async () => ({ data: [] }),
        get: async () => ({
          data: {
            state: 'open',
            base: { ref: 'master' },
            head: { sha: head },
          },
        }),
      },
      repos: {
        createCommitStatus: async ({ sha, state, description }) => {
          statuses.push({ sha, state, description })
        },
        compareCommitsWithBasehead: async () => ({ data: comparison() }),
      },
    },
  }
  const context = {
    eventName: 'push',
    payload: { after: base },
    sha: base,
    repo: { owner: 'paperclipai', repo: 'paperclip' },
    runId: 1,
    serverUrl: 'https://github.com',
  }
  const core = {
    error: () => {},
    warning: (message) => warnings.push(message),
    setFailed: () => {},
  }

  await runBranchFreshness({ github, context, core })

  assert.equal(statuses[0].sha, head)
  assert.equal(statuses[0].state, 'pending')
  assert.equal(statuses.at(-1).state, 'success')
  assert.match(warnings[0], /trying GraphQL/)
})

test('REST and GraphQL enumeration failures fall back to search and invalidate exact heads', async () => {
  const statuses = []
  const warnings = []
  const github = {
    request: rulesetRequest(),
    paginate: async (route) => {
      if (route === github.rest.pulls.list) throw new Error('REST pull API unavailable')
      assert.equal(route, github.rest.search.issuesAndPullRequests)
      return [{ number: 42 }]
    },
    graphql: async () => {
      throw new Error('GraphQL pull API unavailable')
    },
    rest: {
      git: { getRef: async () => ({ data: { object: { sha: base } } }) },
      pulls: {
        list: async () => ({ data: [] }),
        get: async () => ({
          data: {
            state: 'open',
            base: { ref: 'master' },
            head: { sha: head },
          },
        }),
      },
      search: {
        issuesAndPullRequests: async () => ({ data: [] }),
      },
      repos: {
        createCommitStatus: async ({ sha, state, description }) => {
          statuses.push({ sha, state, description })
        },
        compareCommitsWithBasehead: async () => ({ data: comparison() }),
      },
    },
  }
  const context = {
    eventName: 'push',
    payload: { after: base },
    sha: base,
    repo: { owner: 'paperclipai', repo: 'paperclip' },
    runId: 1,
    serverUrl: 'https://github.com',
  }
  const core = {
    error: () => {},
    warning: (message) => warnings.push(message),
    setFailed: () => {},
  }

  await runBranchFreshness({ github, context, core })

  assert.deepEqual(statuses.at(0), {
    sha: head,
    state: 'pending',
    description: 'Checking head against protected master.',
  })
  assert.equal(statuses.at(-1).state, 'success')
  assert.match(warnings[0], /trying GraphQL/)
  assert.match(warnings[1], /trying search/)
})

test('failure of every enumeration path records error on the protected-base event', async () => {
  const statuses = []
  const errors = []
  let failure
  const github = {
    request: rulesetRequest(),
    paginate: async () => {
      throw new Error('pull API unavailable')
    },
    graphql: async () => {
      throw new Error('GraphQL pull API unavailable')
    },
    rest: {
      pulls: { list: async () => ({ data: [] }) },
      search: {
        issuesAndPullRequests: async () => ({ data: [] }),
      },
      repos: {
        createCommitStatus: async ({ sha, state, description }) => {
          statuses.push({ sha, state, description })
        },
      },
    },
  }
  github.paginate = async (route) => {
    if (route === github.rest.pulls.list) throw new Error('pull API unavailable')
    throw new Error('search API unavailable')
  }
  const context = {
    eventName: 'push',
    payload: { after: base },
    sha: base,
    repo: { owner: 'paperclipai', repo: 'paperclip' },
    runId: 1,
    serverUrl: 'https://github.com',
  }
  const core = {
    error: (message) => errors.push(message),
    setFailed: (message) => { failure = message },
  }

  await runBranchFreshness({ github, context, core })

  assert.deepEqual(statuses, [{
    sha: base,
    state: 'error',
    description: 'Open pull requests for protected master could not be enumerated.',
  }])
  assert.match(errors[0], /search API unavailable/)
  assert.match(failure, /could not be enumerated/)
})

test('all known heads begin invalidation without waiting for an earlier status write', async () => {
  const otherHead = 'c'.repeat(40)
  const statuses = []
  let releaseFirstInvalidation
  const firstInvalidation = new Promise((resolve) => {
    releaseFirstInvalidation = resolve
  })
  const pulls = [
    { number: 41, head: { sha: head } },
    { number: 42, head: { sha: otherHead } },
  ]
  const github = {
    request: rulesetRequest(),
    paginate: async () => pulls,
    rest: {
      git: { getRef: async () => ({ data: { object: { sha: base } } }) },
      pulls: {
        list: async () => ({ data: pulls }),
        get: async ({ pull_number: number }) => ({
          data: {
            state: 'open',
            base: { ref: 'master' },
            head: { sha: number === 41 ? head : otherHead },
          },
        }),
      },
      repos: {
        createCommitStatus: async ({ sha, state }) => {
          statuses.push({ sha, state })
          if (statuses.length === 1) await firstInvalidation
        },
        compareCommitsWithBasehead: async () => ({ data: comparison({ behind_by: 1 }) }),
      },
    },
  }
  const context = {
    eventName: 'push',
    payload: { after: base },
    sha: base,
    repo: { owner: 'paperclipai', repo: 'paperclip' },
    runId: 1,
    serverUrl: 'https://github.com',
  }
  const core = { error: () => {}, setFailed: () => {} }

  const run = runBranchFreshness({ github, context, core })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(statuses, [
    { sha: head, state: 'pending' },
    { sha: otherHead, state: 'pending' },
  ])
  releaseFirstInvalidation()
  await run
})

test('a base change during success publication overwrites the transient success', async () => {
  const newerBase = 'c'.repeat(40)
  const statuses = []
  let baseRead = 0
  let failure
  const github = {
    request: rulesetRequest(),
    rest: {
      git: {
        getRef: async () => ({
          data: { object: { sha: ++baseRead < 3 ? base : newerBase } },
        }),
      },
      pulls: {
        get: async () => ({
          data: {
            state: 'open',
            base: { ref: 'master' },
            head: { sha: head },
          },
        }),
      },
      repos: {
        createCommitStatus: async ({ sha, state, description }) => {
          statuses.push({ sha, state, description })
        },
        compareCommitsWithBasehead: async () => ({ data: comparison() }),
      },
    },
  }
  const context = {
    eventName: 'pull_request_target',
    payload: { pull_request: { number: 42, head: { sha: head } } },
    repo: { owner: 'paperclipai', repo: 'paperclip' },
    runId: 1,
    serverUrl: 'https://github.com',
  }
  const core = { error: () => {}, setFailed: (message) => { failure = message } }

  await runBranchFreshness({ github, context, core })

  assert.equal(statuses.at(-2).state, 'success')
  assert.deepEqual(statuses.at(-1), {
    sha: head,
    state: 'error',
    description: `Published comparison for protected master ${base} became stale.`,
  })
  assert.match(failure, /unavailable or stale/)
})

test('a rejected first invalidation is retried and cannot preserve prior success', async () => {
  const statuses = []
  let statusAttempt = 0
  let failure
  const github = {
    request: rulesetRequest(strictRuleset({ enforcement: 'disabled' })),
    rest: {
      git: { getRef: async () => ({ data: { object: { sha: base } } }) },
      pulls: {
        get: async () => ({
          data: {
            state: 'open',
            base: { ref: 'master' },
            head: { sha: head },
          },
        }),
      },
      repos: {
        createCommitStatus: async ({ sha, state, description }) => {
          statusAttempt += 1
          if (statusAttempt === 1) throw new Error('transient status failure')
          statuses.push({ sha, state, description })
        },
        compareCommitsWithBasehead: async () => ({ data: comparison() }),
      },
    },
  }
  const context = {
    eventName: 'pull_request_target',
    payload: { pull_request: { number: 42, head: { sha: head } } },
    repo: { owner: 'paperclipai', repo: 'paperclip' },
    runId: 1,
    serverUrl: 'https://github.com',
  }
  const core = { error: () => {}, setFailed: (message) => { failure = message } }

  await runBranchFreshness({ github, context, core })

  assert.equal(statuses[0].state, 'pending')
  assert.deepEqual(statuses.at(-1), {
    sha: head,
    state: 'error',
    description: 'Strict branch-freshness enforcement is unavailable.',
  })
  assert.match(failure, /unavailable or stale/)
})
