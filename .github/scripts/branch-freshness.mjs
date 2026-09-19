const SHA_PATTERN = /^[0-9a-f]{40}$/

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requireSha(value, field) {
  if (!SHA_PATTERN.test(value ?? '')) {
    throw new Error(`${field} did not provide an exact 40-character SHA`)
  }
  return value
}

export function successDescription(protectedBase, baseSha) {
  return `Protected ${protectedBase} ${baseSha} is included in this head.`
}

export function hasStrictFreshnessEnforcement({
  ruleset,
  statusContext,
  statusIntegrationId,
}) {
  if (ruleset?.enforcement !== 'active' || !Array.isArray(ruleset.rules)) return false

  return ruleset.rules.some((rule) => (
    rule?.type === 'required_status_checks'
    && rule.parameters?.strict_required_status_checks_policy === true
    && Array.isArray(rule.parameters?.required_status_checks)
    && rule.parameters.required_status_checks.some((check) => (
      check?.context === statusContext
      && check?.integration_id === statusIntegrationId
    ))
  ))
}

export function computeFreshnessStatus({
  comparison,
  protectedBase,
  observedHeadSha,
  observedBaseSha,
  liveHeadSha,
  liveBaseSha,
}) {
  requireSha(observedHeadSha, 'Observed pull request head')
  requireSha(observedBaseSha, 'Observed protected base')

  if (liveHeadSha !== observedHeadSha || liveBaseSha !== observedBaseSha) {
    return {
      state: 'error',
      description: `Comparison for protected ${protectedBase} ${observedBaseSha} became stale.`,
      stale: true,
    }
  }

  if (
    !isRecord(comparison)
    || comparison.base_commit?.sha !== observedBaseSha
    || !Number.isInteger(comparison.behind_by)
    || comparison.behind_by < 0
  ) {
    return {
      state: 'error',
      description: `Comparison with protected ${protectedBase} ${observedBaseSha} is unavailable.`,
      stale: false,
    }
  }

  if (comparison.behind_by > 0) {
    return {
      state: 'failure',
      description: `Head is behind protected ${protectedBase} ${observedBaseSha} by ${comparison.behind_by} commit(s).`,
      stale: false,
    }
  }

  return {
    state: 'success',
    description: successDescription(protectedBase, observedBaseSha),
    stale: false,
  }
}

export async function runBranchFreshness({
  github,
  context,
  core,
  protectedBase = 'master',
  statusContext = 'branch-freshness',
  rulesetId = 13619726,
  statusIntegrationId = 15368,
}) {
  const statusTargetUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`

  async function protectedBaseSha() {
    const response = await github.rest.git.getRef({
      ...context.repo,
      ref: `heads/${protectedBase}`,
    })
    return requireSha(response.data?.object?.sha, 'Live protected base')
  }

  async function currentPull(number) {
    const response = await github.rest.pulls.get({
      ...context.repo,
      pull_number: number,
    })
    return response.data
  }

  async function strictFreshnessEnforced() {
    const response = await github.request(
      'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}',
      {
        ...context.repo,
        ruleset_id: rulesetId,
      },
    )
    return hasStrictFreshnessEnforcement({
      ruleset: response.data,
      statusContext,
      statusIntegrationId,
    })
  }

  async function publish(headSha, state, description) {
    await github.rest.repos.createCommitStatus({
      ...context.repo,
      sha: requireSha(headSha, 'Status head'),
      context: statusContext,
      state,
      description,
      target_url: statusTargetUrl,
    })
  }

  async function publishEnumerationError(error) {
    const message = error instanceof Error ? error.message : String(error)
    core.error(`Could not enumerate open pull requests: ${message}`)

    // A protected-base push has no pull-request head in its payload. Persist the
    // failed observation on the exact base event commit as well as failing the
    // workflow. Success publication is separately gated on active strict
    // required-status enforcement, so GitHub blocks every stale head immediately
    // even when this run cannot enumerate those heads for status invalidation.
    const eventBaseSha = context.payload?.after ?? context.sha
    try {
      await publish(
        eventBaseSha,
        'error',
        `Open pull requests for protected ${protectedBase} could not be enumerated.`,
      )
    } catch (publishError) {
      const publishMessage = publishError instanceof Error
        ? publishError.message
        : String(publishError)
      core.error(`Could not publish protected-base enumeration error: ${publishMessage}`)
    }
    core.setFailed('Open pull requests could not be enumerated for branch freshness.')
  }

  async function enumerateOpenPulls() {
    try {
      return await github.paginate(github.rest.pulls.list, {
        ...context.repo,
        state: 'open',
        base: protectedBase,
        per_page: 100,
      })
    } catch (restError) {
      const message = restError instanceof Error ? restError.message : String(restError)
      core.warning?.(`REST pull-request enumeration failed; trying GraphQL: ${message}`)
    }

    try {
      const pulls = []
      let cursor = null
      do {
        const response = await github.graphql(
          `query OpenPullHeads($owner: String!, $repo: String!, $cursor: String) {
            repository(owner: $owner, name: $repo) {
              pullRequests(first: 100, after: $cursor, states: OPEN) {
                nodes {
                  number
                  baseRefName
                  headRefOid
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }`,
          {
            owner: context.repo.owner,
            repo: context.repo.repo,
            cursor,
          },
        )
        const connection = response?.repository?.pullRequests
        if (!Array.isArray(connection?.nodes)) {
          throw new Error('GraphQL pull-request enumeration returned an invalid response')
        }
        pulls.push(...connection.nodes
          .filter((pull) => pull?.baseRefName === protectedBase)
          .map((pull) => ({
            number: pull.number,
            head: { sha: pull.headRefOid },
          })))

        if (!connection.pageInfo?.hasNextPage) return pulls
        cursor = connection.pageInfo.endCursor
        if (!cursor) {
          throw new Error('GraphQL pull-request enumeration omitted its next cursor')
        }
      } while (cursor)

      return pulls
    } catch (graphqlError) {
      const message = graphqlError instanceof Error ? graphqlError.message : String(graphqlError)
      core.warning?.(`GraphQL pull-request enumeration failed; trying search: ${message}`)
    }

    // Search is served independently from both repository pull-list surfaces.
    // It yields PR numbers rather than heads, so resolve every result through
    // the exact pull endpoint before publishing any status.
    const matches = await github.paginate(github.rest.search.issuesAndPullRequests, {
      q: `repo:${context.repo.owner}/${context.repo.repo} is:pr is:open base:${protectedBase}`,
      per_page: 100,
    })
    return Promise.all(matches.map(async (match) => {
      const pull = await currentPull(match.number)
      return {
        number: match.number,
        base: pull.base,
        head: pull.head,
      }
    }))
  }

  let pulls
  if (context.eventName === 'pull_request_target') {
    const pull = context.payload.pull_request
    pulls = Number.isInteger(pull?.number)
      ? [{ number: pull.number, headSha: pull.head?.sha }]
      : []
  } else {
    let openPulls
    try {
      openPulls = await enumerateOpenPulls()
    } catch (error) {
      await publishEnumerationError(error)
      return
    }
    pulls = openPulls.map((pull) => ({
      number: pull.number,
      headSha: pull.head?.sha,
    }))
  }

  let comparisonFailed = false
  const preparedPulls = []

  // Invalidate every previously successful status before doing any comparison.
  // This keeps the remaining heads non-successful if a base-push run times out
  // or is cancelled while processing a large set of open pull requests.
  const invalidations = await Promise.allSettled(pulls.map(async (candidate) => {
    const observedHeadSha = requireSha(candidate.headSha, `PR #${candidate.number} event head`)
    await publish(
      observedHeadSha,
      'pending',
      `Checking head against protected ${protectedBase}.`,
    )
    return { ...candidate, observedHeadSha }
  }))

  for (const [index, invalidation] of invalidations.entries()) {
    if (invalidation.status === 'fulfilled') {
      preparedPulls.push(invalidation.value)
    } else {
      comparisonFailed = true
      const message = invalidation.reason instanceof Error
        ? invalidation.reason.message
        : String(invalidation.reason)
      core.error(`PR #${pulls[index].number}: could not publish pending status: ${message}`)
      // Do not abandon a head because its first invalidation failed. A later
      // pending or terminal write may still succeed and replace prior success.
      preparedPulls.push({
        ...pulls[index],
        observedHeadSha: requireSha(
          pulls[index].headSha,
          `PR #${pulls[index].number} event head`,
        ),
      })
    }
  }

  for (const candidate of preparedPulls) {
    let observedHeadSha = candidate.observedHeadSha
    let observedBaseSha

    try {
      const pull = await currentPull(candidate.number)
      if (pull.state !== 'open' || pull.base?.ref !== protectedBase) continue

      const liveHeadSha = requireSha(pull.head?.sha, `PR #${candidate.number} head`)
      if (liveHeadSha !== observedHeadSha) {
        observedHeadSha = liveHeadSha
        await publish(
          observedHeadSha,
          'pending',
          `Checking head against protected ${protectedBase}.`,
        )
      }
      observedBaseSha = await protectedBaseSha()

      await publish(
        observedHeadSha,
        'pending',
        `Checking head against protected ${protectedBase} ${observedBaseSha}.`,
      )
      const comparison = await github.rest.repos.compareCommitsWithBasehead({
        ...context.repo,
        basehead: `${observedBaseSha}...${observedHeadSha}`,
      })
      const [livePull, liveBaseSha] = await Promise.all([
        currentPull(candidate.number),
        protectedBaseSha(),
      ])
      const result = computeFreshnessStatus({
        comparison: comparison.data,
        protectedBase,
        observedHeadSha,
        observedBaseSha,
        liveHeadSha: livePull.head?.sha,
        liveBaseSha,
      })

      if (result.state === 'success' && !await strictFreshnessEnforced()) {
        comparisonFailed = true
        await publish(
          observedHeadSha,
          'error',
          `Strict ${statusContext} enforcement is unavailable.`,
        )
        core.error(`PR #${candidate.number}: strict ${statusContext} enforcement is unavailable.`)
        continue
      }

      await publish(observedHeadSha, result.state, result.description)
      if (result.state === 'error') {
        comparisonFailed = true
        core.error(`PR #${candidate.number}: ${result.description}`)
      } else if (result.state === 'success') {
        // Detect changes during the status write and overwrite transient success.
        // GitHub's commit-status API cannot atomically compare-and-set against a
        // mutable branch ref. A base advance after this final read is therefore
        // blocked at merge time by the native strict policy checked on both sides
        // of publication, while the globally serialized newer event runs next
        // and promptly invalidates the visible status.
        const [publishedPull, publishedBaseSha, enforcementStillActive] = await Promise.all([
          currentPull(candidate.number),
          protectedBaseSha(),
          strictFreshnessEnforced(),
        ])
        if (
          publishedPull.state !== 'open'
          || publishedPull.base?.ref !== protectedBase
          || publishedPull.head?.sha !== observedHeadSha
          || publishedBaseSha !== observedBaseSha
          || !enforcementStillActive
        ) {
          comparisonFailed = true
          await publish(
            observedHeadSha,
            'error',
            `Published comparison for protected ${protectedBase} ${observedBaseSha} became stale.`,
          )
          core.error(`PR #${candidate.number}: published comparison became stale.`)
        }
      }
    } catch (error) {
      comparisonFailed = true
      const message = error instanceof Error ? error.message : String(error)
      core.error(`PR #${candidate.number}: ${message}`)

      if (observedHeadSha) {
        try {
          await publish(
            observedHeadSha,
            'error',
            observedBaseSha
              ? `Comparison with protected ${protectedBase} ${observedBaseSha} is unavailable.`
              : `Comparison with protected ${protectedBase} is unavailable.`,
          )
        } catch (publishError) {
          const publishMessage = publishError instanceof Error ? publishError.message : String(publishError)
          core.error(`PR #${candidate.number}: could not publish error status: ${publishMessage}`)
        }
      }
    }
  }

  if (comparisonFailed) {
    core.setFailed('At least one branch freshness comparison was unavailable or stale.')
  }
}
