# Contributing Guide

Thanks for wanting to contribute!

We really appreciate both small fixes and thoughtful larger changes.

## Two Paths to Get Your Pull Request Accepted

### Path 1: Small, Focused Changes (Fastest way to get merged)

- Pick **one** clear thing to fix/improve
- Touch the **smallest possible number of files**
- Make sure the change is very targeted and easy to review
- All automated checks pass (including Greptile comments)
- No new lint/test failures

These almost always get merged quickly when they're clean.

### Path 2: Bigger or Impactful Changes

- **First** talk about it in Discord → #dev channel  
  → Describe what you're trying to solve  
  → Share rough ideas / approach
- Once there's rough agreement, build it
- In your PR include:
  - Before / After screenshots (or short video if UI/behavior change)
  - Clear description of what & why
  - Proof it works (manual testing notes)
  - All tests passing
  - All Greptile + other PR comments addressed

PRs that follow this path are **much** more likely to be accepted, even when they're large.

## General Rules (both paths)

- Write clear commit messages
- Keep PR title + description meaningful
- One PR = one logical change (unless it's a small related group)
- Run tests locally first
- Be kind in discussions 😄

## Writing a Good PR message

Please include a "thinking path" at the top of your PR message that explains from the top of the project down to what you fixed. E.g.:

### Thinking Path Example 1:

> - Paperclip orchestrates ai-agents for zero-human companies
> - There are many types of adapters for each LLM model provider
> - But LLM's have a context limit and not all agents can automatically compact their context
> - So we need to have an adapter-specific configuration for which adapters can and cannot automatically compact their context
> - This pull request adds per-adapter configuration of compaction, either auto or paperclip managed
> - That way we can get optimal performance from any adapter/provider in Paperclip

### Thinking Path Example 2:

> - Paperclip orchestrates ai-agents for zero-human companies
> - But humans want to watch the agents and oversee their work
> - Human users also operate in teams and so they need their own logins, profiles, views etc.
> - So we have a multi-user system for humans
> - But humans want to be able to update their own profile picture and avatar
> - But the avatar upload form wasn't saving the avatar to the file storage system
> - So this PR fixes the avatar upload form to use the file storage service
> - The benefit is we don't have a one-off file storage for just one aspect of the system, which would cause confusion and extra configuration

Then have the rest of your normal PR message after the Thinking Path.

This should include details about what you did, why you did it, why it matters & the benefits, how we can verify it works, and any risks.

Please include screenshots if possible if you have a visible change. (use something like the [agent-browser skill](https://github.com/vercel-labs/agent-browser/blob/main/skills/agent-browser/SKILL.md) or similar to take screenshots). Ideally, you include before and after screenshots.

Questions? Just ask in #dev — we're happy to help.

## Monorepo bootstrap (first clone / after `git clean`)

The server imports [`@paperclipai/plugin-sdk`](packages/plugins/sdk), which only ships compiled output under `dist/`. Without a build, Node fails with **Cannot find module** … `plugin-sdk/dist/index.js` (e.g. from `server/src/routes/plugins.ts`).

From the repo root, after `pnpm install`:

```bash
pnpm --filter @paperclipai/shared build
pnpm --filter @paperclipai/plugin-sdk build
```

Or run a full `pnpm build` if you prefer. Re-run the SDK build after pulling changes that touch `packages/plugins/sdk` or `packages/shared`.

The UI lists **`hermes-paperclip-adapter`** in [`ui/package.json`](ui/package.json) so Vite can resolve `hermes-paperclip-adapter/ui` (same major line as the server dependency).

## launchd (`io.paperclip.local`)

If you start Paperclip via **LaunchAgents**, ensure:

- **`WorkingDirectory`** is the monorepo root (where `pnpm-workspace.yaml` lives).
- **`PATH`** includes Homebrew **and** your `pnpm` location (e.g. `~/Library/pnpm` or `~/.local/share/pnpm`) so child processes spawned by the CLI can find tooling.
- **`NODE_OPTIONS`**: optional `--max-old-space-size=…` (e.g. `8192`) if you hit **JavaScript heap out of memory**; fix missing modules / restart loops first, since those often amplify memory use.

After `git clean` or a fresh clone, run the bootstrap commands above (or `pnpm dev` from an interactive shell once) before relying on launchd alone.

After editing `io.paperclip.local.plist`, reload the agent:

```bash
launchctl unload ~/Library/LaunchAgents/io.paperclip.local.plist
launchctl load ~/Library/LaunchAgents/io.paperclip.local.plist
```

## "503" on deep links (e.g. `/TCN/agents/.../runs/...`) on localhost

The UI ships a **service worker** ([`ui/public/sw.js`](ui/public/sw.js)) that, on **navigation** requests, returns a synthetic **`503` + "Offline"** when `fetch()` throws (network error). That is **not** necessarily an Express route returning 503: it often happens after a **brief disconnect** to `127.0.0.1` while the server restarts.

[`ui/src/main.tsx`](ui/src/main.tsx) **does not register** the service worker on loopback hosts and **unregisters** existing registrations there, so local dev avoids this pitfall. If you still see stale behaviour, hard-reload once or clear site data for the origin.

## If heap OOM persists

1. Confirm whether **Vite** or the **server** (`tsx`) is crashing (timestamps in `~/.paperclip/launchd.stderr.log`).
2. Review high-volume JSON paths: plugin routes in `server/src/routes/plugins.ts`, plugin loader / webhooks, and any code that `JSON.parse`s large streamed bodies; prefer pagination, size limits, or streaming parsers.

Happy hacking!
