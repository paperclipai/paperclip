# Understanding GitHub PR review bots

A bot can review your PR, leave comments, and give it a 3/5 without preventing
anyone from merging it. That can feel surprising: if the review failed, why
would GitHub still allow the merge?

The missing piece is that **making the bot a required PR check needs a separate
GitHub repository setting**. GitHub lets you get feedback from a bot without
committing to making that feedback a merge requirement.

**Installing the bot, deciding when it runs, and requiring its result before
merging are three independent choices.**

Here's how they fit together in what we built:

1. **Install the App:** give the bot access to your repository and let GitHub send it notifications.
2. **Choose its triggers:** tell Paperclip when those notifications should cause the agent to review.
3. **Require its check, if you want to:** tell GitHub whether merging must wait for a passing result.

There is also a translation between the second and third choices: the agent's
“3/5” or “5/5” has to become a check result that GitHub understands. We'll walk
through that too.

Imagine we are setting up a bot for a repository that merges PRs into `main`.
We want to understand each choice before turning all of them on. For the full
onboarding procedure, see [GitHub chat and review bots](GITHUB-REVIEW-BOT.md).

## 1. Installing the GitHub App gives the bot access and event notifications

First, the bot needs a way to participate in your repository. You install the
GitHub App on the repositories you choose. Its permissions let it read code,
post comments and reviews, and publish checks.

This establishes what the bot is allowed to do. It does not yet mean “review
every PR,” and it does not mean “nobody can merge without this bot.” Those are
the choices we'll make later.

The App also has a **webhook URL** pointing to Paperclip. A webhook is simply
GitHub sending an HTTP notification to that address when something happens.
This is how Paperclip learns about your PR without repeatedly asking GitHub
whether anything has changed.

Here are the notifications involved:

| What happens on GitHub | Webhook received by Paperclip |
| --- | --- |
| Someone comments on an issue or in a PR's main conversation | `issue_comment` |
| Someone comments in an inline PR review thread | `pull_request_review_comment` |
| Someone opens a PR | `pull_request`, with action `opened` |
| Someone pushes new commits to an existing PR | `pull_request`, with action `synchronize` |

For example, you write `@your-bot please review this PR`. GitHub sends the comment
to the App's webhook, and Paperclip recognizes an authorized request in its
text. There is no separate GitHub mechanism that understands what an AI review
should do; that interpretation belongs to Paperclip.

Our connector does not require a GitHub Actions workflow file in the repository.
Paperclip receives the event and runs the assigned agent in an ordinary
Paperclip task. The bot's App identity supplies its governed GitHub tools.

GitHub installation access and Paperclip's enabled repositories are separate
controls: the App needs access on GitHub, and the repository must also be enabled
for this bot in Paperclip.

See [GitHub's webhook documentation](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

## 2. Paperclip's configuration decides which notifications start a review

Now the bot can hear about repository activity. The next choice is which of
those notifications should actually start work.

That choice matters because you may want help only when you ask for it. Or you
may want every eligible PR reviewed as soon as it opens. Both setups use the
same GitHub App and webhook; Paperclip's configuration changes what happens
after the notification arrives.

You can choose:

- **Mentions only:** someone must explicitly ask the bot to review.
- **Automatic reviews:** review new PRs, updated commits, or other selected events.
- **Both:** review automatically and also accept requests to review again.

Opening a PR, reopening it, marking it ready for review, and pushing new commits
are independently configurable events. Automatic reviews also respect the
configured author, draft, branch, label, and repository restrictions.

Suppose you open our example PR with **mentions only** enabled. GitHub still
notifies Paperclip that the PR opened, but Paperclip does not start an automatic
review. When you add `@your-bot please review`, that authorized request starts
the assigned agent.

If you enable **automatic reviews on new PRs**, opening the same PR starts the
review without anyone mentioning the bot. You can separately enable reviews
for new pushes, or require a fresh mention for those later assessments.

An authorized manual request can bypass automatic scheduling filters. It cannot
bypass repository restrictions, excluded files, or the requester's permissions.

A mention in an ordinary issue starts a task conversation; a PR rating check
concerns a particular PR commit. Ordinary follow-up discussion does not change
the rating. Repeat review requests continue the PR's existing Paperclip task.

## 3. The agent's score becomes a GitHub check result

At this point the agent has done a review. Suppose it finds a problem and gives
our PR a **3/5**. What does GitHub do with that number?

On its own, nothing. **GitHub has no built-in concept of 5/5.** It does not read a
bot's comment and infer that “3/5” should prevent merging. The score belongs to
Paperclip's assessment format and rating policy.

To make the result usable by GitHub's merge rules, Paperclip translates the
assessment into a **check run** named **Paperclip Review**. This is the same
kind of GitHub object you see for a build or a test result.

The agent submits a structured assessment containing the reviewed commit,
score, findings, rationale, and coverage. Paperclip validates the result and
compares it with the configured threshold. The agent does not directly choose
an arbitrary passing check result.

With a minimum score of 5:

```text
Agent submits a complete assessment: 3/5
    → Paperclip validates it
    → Paperclip reports failure to GitHub

Agent submits a complete assessment: 5/5
    → Paperclip validates it
    → Paperclip reports success to GitHub
```

You can therefore see both a comment saying “3/5” and a red **Paperclip Review**
check on the PR. The comment explains the result to a person. The check gives
GitHub a result its rules can use. The check is attached to the exact commit
the agent reviewed.

| Review situation | What the check reports |
| --- | --- |
| Waiting for the agent | Queued |
| Agent is reviewing | In progress |
| Complete assessment meets the threshold | Success |
| Complete assessment falls below the threshold | Failure |
| Incomplete assessment or execution that cannot finish | A non-passing result requiring attention |
| Complete assessment in report-only mode | Neutral; a low score does not fail the check |

The threshold defaults to 5/5 and can be set from 1–5. An incomplete assessment
cannot pass. Report-only mode is useful for feedback without enforcing a score;
it is not a substitute for a required score threshold.

For our Storybook example, the configured review instructions ask the agent to
generate and build stories, render the pages, and look for visible `oogabooga`.
A complete run finding the word scores 5/5; a complete run finding no matching
page scores 3/5. A build failure leaves the assessment incomplete. With a 5/5
threshold, only the first outcome passes.

See [GitHub's Checks API guide](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks).

## 4. GitHub's repository rules decide whether the check blocks merging

Our example PR now has a red **Paperclip Review** check. We still have one choice
left: should that result prevent merging?

**A bot can publish a failing check without preventing a merge.** GitHub allows
checks to provide optional feedback. The repository owner decides which checks
are important enough to require before code reaches a branch such as `main`.

That is why installing the bot or enabling automatic reviews does not create a
merge requirement. You might want to try a reviewer and inspect its feedback
before making the whole team's merges depend on it.

To make its result mandatory, a repository administrator configures a rule
that means: **“PRs into `main` need a passing Paperclip Review check.”**

A typical setup is:

1. Install and configure the bot, then let it publish its first **Paperclip Review** check.
2. Open the repository's **Settings → Rules → Rulesets**.
3. Create or edit a branch ruleset targeting the branch you merge into, such as `main`.
4. Enable **Require status checks to pass** and add **Paperclip Review**.
5. Select the bot App as the expected source where available, so a result from a different integration does not satisfy the requirement.
6. Set the ruleset's enforcement to **Active** and choose bypass permissions deliberately.

A classic branch-protection rule can also require the check. Organization rules
may already impose requirements on a repository. Paperclip does not automatically
change these GitHub rules when you install or configure a bot.

**Requiring the check does not itself start the agent.** It tells GitHub to wait
for the result. The trigger configuration in Paperclip still decides when the
agent runs.

For example, you can require the check while leaving the bot in mentions-only
mode. That is a valid setup: someone must explicitly ask for a review before
the PR can satisfy the merge rule. Turning on automatic reviews removes that
manual initiation step; it does not make the merge rule stronger.

If nobody triggers a required review, the missing result prevents merging for
users subject to the rule. If the connector receives a PR event but automatic
execution is disallowed under its configured rating policy, it can publish
**Authorized manual review required**. An authorized mention can then start the
review.

GitHub plan and repository visibility affect whether these rules are available.
Verify that the rule is active and applies to the target branch; a visible check
alone does not prove merge enforcement. Configured bypass rights still apply.

See [available rules for GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
and [creating a repository ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository).

## The four useful combinations

We can now put the two behavior choices next to each other. This is why
“the bot reviews PRs” does not, by itself, tell you whether it runs automatically
or whether its result is mandatory:

| Review trigger | GitHub requires Paperclip Review? | What happens |
| --- | --- | --- |
| Mentions only | No | Optional review when someone asks. Its failing check alone does not block merging. |
| Automatic | No | Automatic feedback. Its failing check alone does not block merging. |
| Mentions only | Yes | Merging waits until someone requests a review and the required check passes. |
| Automatic | Yes | Reviews run automatically. Merging waits for the required check to pass. |

Other repository rules, including formal review requirements, may independently
block a merge in any of these scenarios.

## What happens when someone pushes again or mentions the bot again?

Suppose the agent gives our PR a 3/5 and the required check fails. You fix the
problem and push another commit.

GitHub now needs an assessment of that new code. A check result belongs to the
commit it assessed: even if the previous version had passed, that result would
not establish that the new version is good.

What happens next depends on the trigger choice we made earlier:

- **Automatic push reviews enabled:** the push notification starts a new review.
- **Push reviews disabled:** you write `@your-bot please review again` to start it.

The agent reviews the new commit, submits a complete 5/5, and Paperclip publishes
a successful check. The PR has now satisfied **this** merge requirement. Other
required checks or human approvals may still be outstanding.

A repeat review mention can also request a fresh assessment of the same commit.
The conversation continues in the same Paperclip task, with review history
retained and one current summary updated. Old executions cannot overwrite the
latest head's assessment.

See [GitHub status checks](https://docs.github.com/en/pull-requests/reference/status-checks).

## Formal Approve and Request changes reviews are separate

GitHub also supports formal PR reviews: **Approve**, **Request changes**, and
comment-only reviews. These participate in GitHub's review policies, which are
separate from required status checks.

This is another place where the word “review” can be confusing. We have been
talking about an agent assessing code and producing a check. Clicking GitHub's
**Approve** button—or having a bot perform that action through the API—is a
separate operation.

You may want the agent's assessment to be mandatory while still reserving
approval for a human. Requiring the bot's check and separately requiring human
review lets you express both expectations.

Three things can therefore appear on the same PR:

| Item | What it means |
| --- | --- |
| A summary comment saying “5/5” | The bot's explanation of its assessment. |
| A successful **Paperclip Review** check | The validated assessment satisfied the configured rating policy for that commit. |
| A formal **Approved** review | The bot explicitly performed GitHub's approval action under separately enabled permissions. |

A 5/5 does not automatically submit a formal approval. A formal approval does
not turn a failing check green. Neither replaces other required checks or human
review requirements.

Paperclip's **APPROVE** and **REQUEST_CHANGES** permissions are individually
configurable and both off by default. Enabling an action allows the agent to
request it through a governed tool; it does not automatically perform it.

See [GitHub's protected-branch and review requirements](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## A practical setup for an automatic required reviewer

- Install the App on the intended repositories and enable them in Paperclip.
- Enable reviews on new PRs and updated commits, plus authorized repeat mentions.
- Set the minimum score to 5/5.
- In GitHub, require **Paperclip Review** for the target branch, using the bot App as its expected source where available.
- Keep formal bot approvals off unless you specifically want that separate action.
- Configure any human approval requirements independently.

With that setup, opening a PR starts the agent, the assessment becomes a check,
and GitHub waits for that check to pass. A push starts a fresh assessment of the
new code, and a mention lets you explicitly ask for another review. Each part
has its own job, and you choose each one deliberately.
