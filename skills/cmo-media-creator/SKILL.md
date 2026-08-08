---
name: cmo-media-creator
description: Create marketing images and short AI videos for Paperclip CMO workflows; use for on-brand visuals, ad creative, social images, campaign banners, text-to-video, image-to-video, product explainer clips, and reusable media generation prompts with Skillboss-backed image and Veo generation.
---

# CMO Media Creator

Create draft marketing media quickly while preserving Iron Noodle brand, legal
marketing compliance, white-label rules, and Paperclip traceability.

> **Single-machine skill.** Absolute paths in this skill (e.g.
> `/Users/bertostanley/paperclip/skills/cmo-media-creator`) are intentionally pinned to the
> Paperclip host and are not portable — update them if the skill is re-deployed elsewhere.

## Ground Rules

- Treat every generated image or video as a draft until reviewed.
- Do not publish, email, text, or post externally unless the task explicitly says
  it is approved for outbound.
- Never include these names in client-facing assets or captions: Skillboss,
  OpenAI, Claude, Anthropic, OpenRouter, Gemini, Veo, Synthflow, ElevenLabs,
  GoHighLevel, Zapier, Docker, Tailscale, or Mac Mini.
- Never fabricate testimonials, client results, case outcomes, awards, logos,
  attorney endorsements, compliance badges, or before/after claims.
- For law-firm prospect content, default to bankruptcy pain points unless the
  task gives another practice area.
- Store final drafts under a durable project or task folder, not only `/tmp`.
- Report the prompt, model, output path, review status, and any assumptions in
  the Paperclip issue comment.

## Workflow

1. Read the task and identify the asset type:
   - `image`: static creative, ad image, hero image, thumbnail, social visual.
   - `video`: text-to-video from a written scene.
   - `image-to-video`: animate an existing image URL or local image.
   - `prompt-only`: produce prompts and a media brief when generation is not
     available in the current runtime.
2. Build a concise media brief:
   - audience, practice area, campaign goal, channel, aspect ratio, duration,
     required text, forbidden text, brand constraints, and review owner.
   - If any of these are unknown, make conservative assumptions and list them.
3. Check [references/media-policy.md](references/media-policy.md) before
   generating law-firm or prospect-facing assets.
4. Use [scripts/prepare-media-job.py](scripts/prepare-media-job.py) to validate
   the brief and print a generation command when shell access is available.
5. Generate the asset with Skillboss if the runtime can execute shell commands.
   If command execution is unavailable, create a Paperclip task for a
   media-capable agent and attach the brief plus prompt.
6. Inspect the artifact before marking done:
   - no white-label/vendor terms
   - no fake legal claims or testimonials
   - readable text if text was requested
   - correct aspect ratio and channel fit
   - no distorted logos, faces, hands, or legal documents
7. Leave a Paperclip comment with:
   - asset type and goal
   - prompt used
   - model used
   - saved path or URL
   - review status: `draft`, `needs human review`, or `approved by task context`

When running on the Mini through Paperclip, this skill is installed at:

```text
/Users/bertostanley/paperclip/skills/cmo-media-creator
```

If Paperclip only injects this `SKILL.md`, use that absolute path to read the
reference files or run the helper script.

## Higgsfield OAuth CLI Verification

The previous working Higgsfield lane uses the local OAuth CLI, not the Cloud API billing bucket. When the Mini has `~/.config/higgsfield/credentials.json` and the `higgsfield` CLI is authenticated, this lane can use the Plus-plan UI/subscription credits.

Verify it before use:

```bash
$HOME/paperclip/skills/cmo-media-creator/scripts/higgsfield-oauth-verify.sh
```

Expected success reports account email, plan, available credits, and a no-generation cost probe. If OAuth is valid and Cloud API reports `not_enough_credits`, prefer OAuth CLI for Higgsfield generation and keep fal.ai as fallback.

## Higgsfield Headless API Verification

Higgsfield headless API credentials should be exposed only to media-creation roles as `HF_CREDENTIALS=KEY_ID:KEY_SECRET` (or split `HF_API_KEY` + `HF_API_SECRET`). Treat this like `FAL_KEY`; never print it in comments or logs.

Before relying on Higgsfield for autonomous CMO generation, run the cheap verifier from the Mini/runtime:

```bash
node "$HOME/paperclip/skills/cmo-media-creator/scripts/higgsfield-verify.js"
```

Expected success is a validation/auth-reachable result for an intentionally empty prompt. The verifier is dependency-free and uses the same v2 HTTP shape as the official SDK (`Authorization: Key KEY_ID:KEY_SECRET`). If it reports missing env or auth rejected, do not claim Higgsfield is available; use fal.ai fallback or create the exact blocker. If it reports `not_enough_credits`, credentials are valid but paid generation remains blocked until credits are added. If it reports a queued request, API credits are active and generation can run; use OAuth CLI cost probe for no-generation checks when possible.

## Default Models

Use these defaults unless the task specifies otherwise:

| Need | Model |
|---|---|
| Fast marketing image | `vertex/gemini-2.5-flash-image-preview` |
| Higher-fidelity image | `vertex/gemini-3-pro-image-preview` |
| Short text-to-video | `vertex/veo-3.1-fast-generate-preview` |
| Image-to-video fallback | `mm/i2v` |

If the task specifically asks for OpenAI image generation and the Codex image
CLI is available, use `gpt-image-1` for non-transparent image work. Do not use
`gpt-image-1` for native transparent backgrounds.

## Command Pattern

Prefer the Skillboss CLI on the Mini:

```bash
node "$HOME/.claude/skills/skillboss/scripts/api-hub.js" image \
  --model "vertex/gemini-3-pro-image-preview" \
  --prompt "<prompt>" \
  --output "<output-path>"
```

```bash
node "$HOME/.claude/skills/skillboss/scripts/api-hub.js" video \
  --model "vertex/veo-3.1-fast-generate-preview" \
  --prompt "<prompt>" \
  --output "<output-path>"
```

For image-to-video:

```bash
node "$HOME/.claude/skills/skillboss/scripts/api-hub.js" video \
  --model "mm/i2v" \
  --image "<image-url-or-path>" \
  --prompt "<animation prompt>" \
  --output "<output-path>"
```

If the direct path is missing, search for `api-hub.js` under
`$HOME/.claude/skills/skillboss` and `$HOME/.codex/skills/skillboss`. Use `npx
skillboss` only when the installed CLI is configured.

## Prompt Pattern

Use concrete, production-oriented prompts:

```text
Create a [asset type] for [audience/channel].
Goal: [campaign objective].
Scene: [specific visual scene].
Style: premium legal technology brand, confident, clean, credible, no hype.
Brand: Iron Noodle True Blue #003366, Soft Linen #F5F0E8, restrained accent colors.
Copy/text: [exact text or "no text"].
Avoid: vendor names, fake testimonials, fake case results, red/purple palette,
courtroom cliches, robotic stock-art look, watermarks, unreadable text.
Output: [aspect ratio, duration if video, file path].
```

Read [references/prompt-patterns.md](references/prompt-patterns.md) for channel
examples and video shot language.

## Paperclip Handoff

When generation is blocked or the current agent lacks command execution, create
a child issue for a media-capable operator. Include:

- `asset_type`
- `campaign_goal`
- `audience`
- `prompt`
- `model_preference`
- `output_format`
- `review_owner`
- any source image URL/path for image-to-video

Keep the parent issue open until the artifact is generated or the blocker is
explicitly acknowledged.
