# turnstile-spin (skill)

End-to-end setup skill for Cloudflare Turnstile. Loads when an agent is asked to add Turnstile, set up CAPTCHA, or protect a form from bots.

`SKILL.md` is the canonical machine-readable behavior. The hosted prompt at [`developers.cloudflare.com/turnstile/spin/prompt.md`](https://developers.cloudflare.com/turnstile/spin/prompt.md) packages the same behavior for agents that do not have this bundle installed. Product requirements come from the [Turnstile documentation](https://developers.cloudflare.com/turnstile/).

## Layout

| File                              | Purpose                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `SKILL.md`                        | Main wizard instructions for the agent                                 |
| `scripts/auth-probe.sh`           | Probes the customer's Cloudflare API token for Turnstile scope         |
| `scripts/widget-create.sh`        | Creates the Turnstile widget via the Cloudflare API                    |
| `scripts/validate.sh`             | Dummy-siteverify + hostname check at the end of the wizard             |
| `scripts/persist-skill.sh`        | Installs the canonical skill bundle into the user's repo               |
| `references/vanilla-html.md`      | Code snippet for static / vanilla HTML projects                        |
| `references/nextjs-app.md`        | Code snippet for Next.js App Router projects                           |
| `references/nextjs-pages.md`      | Code snippet for Next.js Pages Router projects                         |
| `references/astro.md`             | Code snippet for Astro projects                                        |
| `references/sveltekit.md`         | Code snippet for SvelteKit projects                                    |
| `references/hugo.md`              | Code snippet for Hugo projects                                         |
| `tests/validation.md`             | Validation cases matching the assertions in the PRD                    |

## How agents load it

Agents that load skill bundles from `github.com/cloudflare/skills` will pick this up automatically. For agents that load skills out of a local directory, clone the bundle once and symlink it:

```sh
git clone https://github.com/cloudflare/skills ~/.config/cloudflare-skills
ln -s ~/.config/cloudflare-skills/skills/turnstile-spin ~/.claude/skills/turnstile-spin
```

If cloning is not an option, the hosted single-file prompt is a read-only fallback:

```sh
mkdir -p .claude/skills/turnstile-spin && \
  curl -sSL https://developers.cloudflare.com/turnstile/spin/prompt.md \
  -o .claude/skills/turnstile-spin/SKILL.md
```

The single-file install does not include `scripts/` or `references/`; the hosted prompt fetches those on demand with `fetch_spin_script`. `scripts/persist-skill.sh` requires the cloned bundle above and cannot be used from a single-file install. For other agents, see the table in [`SKILL.md`](./SKILL.md#step-11--persist-the-skill).

## Keep the hosted prompt in sync

Any behavioral change to `SKILL.md` must also be applied to `public/turnstile/spin/prompt.md` in the `cloudflare-docs` repository. The hosted file adds bootstrap instructions, but its wizard, security boundaries, recovery flow, and validation requirements must match this skill.

## Related

- [Canonical docs page](https://developers.cloudflare.com/turnstile/spin/)
- [`cloudflare/skills`](https://github.com/cloudflare/skills) — root index for all Cloudflare agent skills
- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) — canonical siteverify reference
