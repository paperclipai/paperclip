---
name: release-changelog-discord-message
description: >
  Write the Discord release announcement for a stable Paperclip release. Companion
  to `release-changelog` — that skill produces the file at `releases/vYYYY.MDD.P.md`;
  this one turns that file into a single copy-pasteable Discord post in dotta's
  voice and attaches it as the `discord_announcement` document on the release
  issue.
---

# Release Discord Announcement Skill

Write the Discord release announcement for the **stable** Paperclip release.

This is the companion to `.agents/skills/release-changelog/SKILL.md`. That skill
generates the file at `releases/vYYYY.MDD.P.md`. This skill turns that file into
a single copy-pasteable Discord block, in dotta's voice, and posts it as the
`discord_announcement` document on the release issue.

## What dotta said

> This is for discord — try to follow my format. If I have a section where I
> think about the future, pull from recent issues we're working on etc.

The Discord announcement is **not** the changelog. The changelog is exhaustive;
the announcement is opinionated, in-voice, and built around the same handful of
shipped highlights plus a real "what's next" + "what's on my mind" pulled from
current Paperclip work — not invented.

## When to use

- After `release-changelog` has produced `releases/vYYYY.MDD.P.md` on the
  release worktree/PR.
- When the release issue (the one assigned by the release routine) asks for a
  Discord announcement, or has a `discord_announcement` document that needs to
  be refreshed for a new date/version.
- Never run this in isolation. The version, date, contributor list, and
  highlight set MUST match the matching changelog file — if the changelog has
  been updated, refresh this too.

## Output

A single fenced markdown code block, ready to paste into Discord. Attached as
issue document key `discord_announcement` on the release issue, and pasted
verbatim into a comment on that issue so the human can copy it out.

```bash
PUT /api/issues/{releaseIssueId}/documents/discord_announcement
{
  "title": "Discord announcement",
  "format": "markdown",
  "body": "<the announcement>",
  "baseRevisionId": "<latest if updating>"
}
```

If the document already exists, fetch it first and pass the current
`baseRevisionId`. Never overwrite silently — if the version has changed since
the document was last written, mention what changed in the issue comment.

## Format (follow this template)

Use Discord emoji shortcodes (`:paperclip:`, `:lock:`, `:brain:` …) — NOT the
Unicode emoji. Discord renders the shortcodes; the changelog file uses prose.

```
:paperclip: :paperclip: :paperclip: CLIPPERS!!! v{VERSION} IS OUT :paperclip: :paperclip: :paperclip:

OFFICIAL TWITTER: https://x.com/papercliping - follow it, report any others

## Highlights

:emoji: **Feature Name** - one-sentence description in dotta's voice.
:emoji: **Feature Name** - …
:emoji: **Feature Name** - …

... and a long tail of {flavor of the rest}. Read the [full release notes](<github link>).

## WHATS NEXT (:motorway:  Roadmap)

* **Theme A** - one-line forward-looking blurb
* **Theme B** - …
* **Theme C** - …

## What's on my mind

* **Topic** - what's bugging dotta / what's queued / open questions
* **Topic** - …

## PRESS                              (optional — only if there is real press)

* **Outlet / Person** - what happened ([link](<x.com link>))

## WHAT I NEED FROM YOU               (optional — only if there's a real ask)

FOLLOW THE TWITTER: https://x.com/papercliping - that's the only official one
TELL ME if you're using Paperclip in your business - I want to meet you

## Community

Thank you to everyone who contributed to this release!

```
@username1, @username2, @username3
```

## In Summary

PAPERCLIP IS THE AI ORCHESTRATOR FOR HUMANS TO ACCOMPLISH 100x MORE WORK

Every single person will be managing a team of a dozen, or a hundred, or a
thousand agents and Paperclip will be the default tool to manage it all.

ITS TIME TO CLIP :paperclip: :paperclip: :paperclip:

FULL RELEASE NOTES

https://github.com/paperclipai/paperclip/blob/master/releases/v{VERSION}.md

||@everyone||
```

Notes on the template:

- The opening and closing `:paperclip: :paperclip: :paperclip:` bookends are
  part of the brand — keep them.
- Sections may be UPPERCASE or Title Case — dotta has used both. Pick a style
  and stay consistent within a single post.
- Use `||@everyone||` (Discord spoiler-wrapped) at the very end so it pings
  exactly once when the spoiler is removed by the poster.

## Language tips

These are extracted from how dotta has written the last several announcements.
Mimic this register; do not invent a "professional" tone.

- **First person, conversational.** "I want to meet companies using Paperclip",
  "what's on my mind", "if that's you let me know". Not "Paperclip is excited
  to announce".
- **ALL CAPS for excitement and asks**, especially in the opener, the section
  headers, the "WHAT I NEED FROM YOU" section, and the closing tagline. Do not
  ALL-CAPS feature descriptions.
- **One emoji shortcode per highlight bullet**, picked to evoke the feature
  (`:lock:` for secrets, `:brain:` for planning, `:mag:` for search,
  `:cloud:` for cloud / sandbox, `:jigsaw:` for plugins, `:rewind:` for
  history/restore, `:thread:` for threads, etc.).
- **Highlight bullets are one sentence**, opinionated, told from the user's
  perspective — "the cloud-secrets prereq is real now", not "added support
  for…".
- **Tail line after highlights** wraps the rest in a single sentence and links
  to the full release notes ("… and a long tail of {flavor}. Read the [full
  release notes](url).").
- **"WHATS NEXT" is forward-looking themes**, not a literal sprint list. 3–5
  bullets is the right size. Pull these from active goals, in-flight projects,
  and recent issues the team is working on — do not invent themes.
- **"What's on my mind"** is dotta's personal/strategic thinking — docs gaps,
  philosophical positioning ("we're the human control plane for ai labor"),
  invitations ("if you've ever wanted to write about how you use Paperclip,
  hit me up"). Pull real tensions from recent issues/comments; do not invent.
- **Press section** is optional. Only include it if there is real press in the
  release window (a tweet, a podcast, a talk, a star milestone). No press →
  drop the section entirely.
- **"WHAT I NEED FROM YOU"** is optional. Use it for a single concrete ask
  (follow the twitter, intros, beta sign-ups). No real ask → drop it.
- **Community** is the same contributors list that's in the changelog file,
  fenced in a triple-backtick block, comma-separated `@username, @username`.
  Exclude bots and Paperclip founders, same rules as the changelog skill.
- **The "In Summary" mission line** evolves slowly. Use the most recent
  variant unless dotta tells you otherwise. Recent variants:
  - "PAPERCLIP IS THE AI ORCHESTRATOR FOR HUMANS TO ACCOMPLISH 100x MORE WORK"
  - "PAPERCLIP WILL BE THE DEFAULT AGENT-MANAGEMENT TOOL FOR EVERY COMPANY"
  - "Paperclip will be _the_ control plane for AI agents in **every** company."
- **Closing tagline** is always `ITS TIME TO CLIP :paperclip: :paperclip:
  :paperclip:`. Keep it.

## Workflow

1. Read the matching `releases/vYYYY.MDD.P.md` produced by `release-changelog`.
   Use the version and contributor list from that file — never re-derive them.
2. Read the **release issue thread** (the one assigned to you that ran the
   release routine) — comments + linked issues + recent issues in the company
   are the source for `WHATS NEXT` and `What's on my mind`. Pull real themes,
   not invented ones.
3. Re-read the three verbatim examples below — they're the canonical voice.
4. Draft the announcement using the template above.
5. PUT it as the `discord_announcement` document on the release issue (see
   "Output" above). If updating, send the latest `baseRevisionId`.
6. Post a comment on the release issue that includes the announcement inside a
   single fenced markdown code block, so dotta can copy-paste it into Discord
   without opening the document.

Do not publish to Discord. This skill only prepares the artifact.

## Verbatim previous examples

Three previous Discord announcements from dotta, included **verbatim** as the
ground-truth examples for voice, structure, and emoji usage. When in doubt,
match these.

### Example 1 — v2026.403.0

```
CLIPPERS! v2026.403.0 has dropped!! :paperclip: :paperclip: :paperclip:

## Highlights

:inbox_tray:  **Inbox overhaul** - there is a new "mine" tab that has mail-client like keyboard shortcuts. It's my new default view for managing work
:thumbsup:  **Feedback and evals** - you can now vote :thumbsup: / :thumbsdown: on your agent's responses. If you choose to share your traces with me, I'll use it to make Paperclip better. In either case you can export locally for your own org's learning
:page_with_curl:  **Document revisions** - you can now restore old versions of your documents
:ping_pong:  **Telemetry** - this version has anonymized telemetry that helps me better understand the basic uses of Paperclip (adapters and so on) - if you hate that, just it disable with `DO_NOT_TRACK=1` or `PAPERCLIP_TELEMETRY_DISABLED=1` environment variables
:construction_worker: **Execution Workspaces (experimental)** - Paperclip is not a "code review" tool, but I have been finding worktrees are important for certain projects. Enable it in experimental settings
:loop:  **Routine variables** - sometimes you need to customize a routine and the new variables feature makes that easy

PLUS **tons** of improvements aound adapters, bugfixes, qol

## COMMUNITY

HUGE THANKS to the contributors with commits in this release:

```
@aronprins, @bittoby, @edimuj, @HenkDz, @kevmok, @mvanhorn, @radiusred, @remdev, @statxc, @vanductai
```

## WHATS NEXT (ROADMAP)

* **Multi-human users** -- you've been asking for it, we have a draft and will have this shortly
* **Sandbox execution** - the other half of cloud deployment: run your agents in a sandbox across any provider

PLUS: just dealing with the excellent PRs we have sitting in our inbox.

**What's also on my mind (coming soonish)**

* MAXIMIZER MODE - for when you've got a dream and tokens to burn
* Artifacts, work products, and deployments
* CEO Chat
* Stronger agent defaults

## PRESS

I've been doing my part to spread the word about Paperclip

* We talked to the incredible [Andrew Warner of Mixergy Fame](https://x.com/dotta/status/2039087507514507407)
* We gave a tutorial with the [inimitable Greg Isenberg](https://x.com/dotta/status/2037279902445994345)
* We met with the [Seed Club guys](https://x.com/dotta/status/2039020365926576377)
* We crossed [40k stars (46k now!)](https://x.com/dotta/status/2038638188227387613)
* ... and a couple others that will be released in a few days

## SUCCESS STORIES

* [Nevo made $76k in march](https://x.com/dotta/status/2039406772859920758) after using Paperclip to automate his marketing
* [Lewis Jackson](https://x.com/WhatSayLew/status/2039810227394978158) said 34 agents were already operating his trading firm through Paperclip and called it his "holy s***" AI moment.
* [Neal Kotak](https://x.com/nkotak1/status/2039582439459209638) said Paperclip already runs most of Roominary for him and praised how strong the product is.
* [Sam Woods](https://x.com/samwoods/status/2039039305960587755) said he knows several people who moved from OpenClaw to Paperclip, often with Hermes in the stack, and that they love it.
* [Josh Galt](https://x.com/JoshGalt/status/2039386307219095557) called Paperclip the coolest agent tooling he has used and said it is finally something that just works.

## IN SUMMARY

I know there are still some rough edges, but

Paperclip will be *the* control plane for AI agents in **every** company.

and I think we're moving at a pretty good clip :paperclip: :paperclip: :paperclip:

FULL RELEASE NOTES HERE

https://github.com/paperclipai/paperclip/releases/tag/v2026.403.0

||@everyone||
```

### Example 2 — v2026.416.0

```
:paperclip: :paperclip: :paperclip: CLIPPERS!!! v2026.416.0 IS OUT :paperclip: :paperclip: :paperclip:

## Highlights

This release has *tons* of quality of life improvements around speed, performance, and workflow. You should notice that comment threads feel faster and your agents stay on task longer

:thread: Issue chat threads now are a conversation more than comments
:police_officer: Execution policies like **Reviewer** and **Approver** are now first-class in the harness (e.g. enforce that QA *must* review a task)
:no_smoking: Blocker dependencies - first-class "wake on blocker resolved" which means now you can have "task graphs" that depend on one another and it's enforced by Paperclip
:woman_feeding_baby: Parent-child tasks - better support for sub-tasks all around, which makes it much easier to organize your work

And then a million fixes around ux, details, keyboard shortcuts, bug fixes, security fixes, etc. Really you should read the [full release notes here](https://github.com/paperclipai/paperclip/releases/tag/v2026.416.0)

## COMMUNITY

INCREDIBLE INCREDIBLE WORK BY folks with commits and reports in this release:

```
@AllenHyang, @antonio-mello-ai, @aronprins, @chrisschwer, @cleanunicorn, @DanielSousa, @davison, @ergonaworks, @HearthCore, @HenkDz, @KhairulA, @kimnamu, @Lempkey, @marysomething99-prog, @mvanhorn, @officialasishkumar, @plind-dm, @shoaib050326, @sparkeros, @wbelt, @offset, @sagilayani, @mattdonnelly10, @peaktwilight, @YuvalElbar6
```

## WHATS NEXT (:motorway:  Roadmap)

* **Multi-human users** - in the last stages of testing, Paperclip is better with teams
* **Memory Infrastructure** - your agents will remember everything about yoru business
* **Sandbox execution** - run your agents anywhere

## What's on my mind

* I want to meet with companies who are using Paperclip in their business - if that's you let me know
* We need more Paperclip tutorials, defaults, and education - thanks to @aronprins for his work in this area already!
* We still need to get better at reviewing your PRs and we're improving our process every day
* "Zero-human company" language has to go - we're the human control plane for ai labor
* We're adding better support for *knowledge (wikis & files)*, *artifacts*, and *work product* in Paperclip soon.

## PRESS

* **AI Engineer Europe Tutorial** - I gave a tutorial for AIE. If someone is looking for a basics ABC of Paperclip [you can send them this](https://x.com/dotta/status/2044575580264316931)
* **AI Club Chicago** - JB gave a talk on Paperclip [at AI Tinkerers in Chicago](https://x.com/developwithJB/status/2044281068778316268) !

## IN SUMMARY

PAPERCLIP WILL BE THE DEFAULT AGENT-MANAGEMENT TOOL FOR EVERY COMPANY

If there's anything I can do to help you and your company use Paperclip, hit me up. Until then, enjoy the new release

ITS TIME TO CLIP :paperclip: :paperclip: :paperclip:

FULL RELEASE NOTES

https://github.com/paperclipai/paperclip/releases/tag/v2026.416.0

||@everyone||
```

### Example 3 — v2026.427.0

```
:paperclip: :paperclip: :paperclip: CLIPPERS!!! v2026.427.0 IS OUT :paperclip: :paperclip: :paperclip:

THIS IS THE OFFICIAL TWITTER FOLLOW IT: https://x.com/papercliping

## Highlights

:man_feeding_baby: **MULTI USER** - you can now invite multiple users to your instance
:factory_worker:  **HARDER WORKING** - robosut liveness continuations and lifecycle recovery means your instance tries harder before involving you
:white_check_mark:  **SUBISSUE CHECKLISTS** - subissues have better ordering which allows for long-run planning
:thread: **Rich Thread UX** - now your agents can ask you questions, ask for approvals, suggest tasks and you can approve or refine them right in your task threads
:cloud:  **BETA: Sandbox Providers** - Cloud sandboxing is in beta - the API ships in this release and we'll be adding more providers
... and *tons* of other improvements and bugfixes.

## Community

Thank you to everyone who contributed to this release!

```
@akhater, @aronprins, @GodsBoy, @LeonSGP43, @neerazz, @NoronhaH, @rbarinov, @rvanduiven, @SgtPooki, @superbiche
```

## WHATS NEXT (:motorway:  Roadmap)

* **Longer-range planning and execution** - Paperclip will support longer and longer tasks and work until it's done
* **Secrets Service v2** - an important prereq for Paperclip cloud
* **Artifacts, memory, and knowledge**
* **Conference Room** aka CEO/Agent Chat

## What's on my mind

* **Documentation & Blog posts** - I've fallen behind on the docs but aron has done a good job here - we'll be setting up Clips to help maintain these
* **Paperclip Cloud** - will be a critical unlock for us, but even the shared team story needs developed more - *where should the work be done* and *where are the outputs stored* and *how do we surface them to users*? Each of these questions are a core Paperclip service that needs developed
* **Paperclip Bench** - In the vein of SWE-Bench I've started an internal benchmark for Paperclip - we have to be able to measure that our changes are improving the system and not regressing
* **Paperclip Connections Store** - connecting to Github, Slack, Google Docs, and the hundreds of other services we use every day should be easy, secure, and configurable per agent and team

## Press

I met with the [Wisemen about Paperclip](https://x.com/dotta/status/2045146539534827998)

## WHAT I NEED FROM YOU

FOLLOW THIS TWITTER ACCOUNT: https://x.com/papercliping - that's the only official one, report any others

## In Summary

PAPERCLIP IS THE AI ORCHESTRATOR FOR HUMANS TO ACCOMPLISH 100x MORE WORK

Every single person will be managing a team of a dozen, or a hundred, or a thousand agents and Paperclip will be the default tool to manage it all.

ITS TIME TO CLIP :paperclip: :paperclip: :paperclip:

FULL RELEASE NOTES

https://github.com/paperclipai/paperclip/blob/master/releases/v2026.427.0.md

||@everyone||
```

## Review checklist

Before handing off:

1. Version + date match the matching `releases/vYYYY.MDD.P.md` exactly.
2. Contributor list matches the changelog (same exclusions: bots, founders).
3. Highlights are a subset of the changelog Highlights — same shipped features,
   not invented or pre-alpha work.
4. `WHATS NEXT` and `What's on my mind` are pulled from real recent issues /
   active goals — not invented themes.
5. Section style (UPPERCASE vs Title Case) is internally consistent.
6. Closing tagline is `ITS TIME TO CLIP :paperclip: :paperclip: :paperclip:`
   and `||@everyone||` is the very last line.
7. Document `discord_announcement` is updated on the release issue, and the
   announcement is also posted in a comment inside a fenced code block.

This skill never posts to Discord. It only prepares the announcement artifact.
