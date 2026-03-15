---
name: last30days
version: "2.9.5"
description: "Research a topic from the last 30 days. Also triggered by 'last30'. Sources: Reddit, X, Bluesky, Truth Social, YouTube, TikTok, Instagram, Hacker News, Polymarket, web. Become an expert and write copy-paste-ready prompts."
argument-hint: 'last30 AI video tools, last30 best project management tools'
allowed-tools: Bash, Read, Write, AskUserQuestion, WebSearch
homepage: https://github.com/mvanhorn/last30days-skill
repository: https://github.com/mvanhorn/last30days-skill
author: mvanhorn
license: MIT
user-invocable: true
metadata:
  openclaw:
    emoji: "📰"
    requires:
      env:
        - SCRAPECREATORS_API_KEY
      optionalEnv:
        - OPENAI_API_KEY
        - XAI_API_KEY
        - OPENROUTER_API_KEY
        - PARALLEL_API_KEY
        - BRAVE_API_KEY
        - APIFY_API_TOKEN
        - AUTH_TOKEN
        - CT0
        - BSKY_HANDLE
        - BSKY_APP_PASSWORD
        - TRUTHSOCIAL_TOKEN
      bins:
        - node
        - python3
    primaryEnv: SCRAPECREATORS_API_KEY
    files:
      - "scripts/*"
    homepage: https://github.com/mvanhorn/last30days-skill
    tags:
      - research
      - reddit
      - x
      - youtube
      - tiktok
      - instagram
      - hackernews
      - polymarket
      - truthsocial
      - trends
      - prompts
---

# last30days v2.9.5: Research Any Topic from the Last 30 Days

> **Permissions overview:** Reads public web/platform data and optionally saves research briefings to `~/Documents/Last30Days/`. X/Twitter search uses optional user-provided tokens (AUTH_TOKEN/CT0 env vars). Bluesky search uses optional app password (BSKY_HANDLE/BSKY_APP_PASSWORD env vars - create at bsky.app/settings/app-passwords). Truth Social search uses optional bearer token (TRUTHSOCIAL_TOKEN env var - extract from browser dev tools). All credential usage and data writes are documented in the [Security & Permissions](#security--permissions) section.

Research ANY topic across Reddit, X, Bluesky, Truth Social, YouTube, TikTok, Hacker News, Polymarket, and the web. Surface what people are actually discussing, recommending, betting on, and debating right now.

## CRITICAL: Parse User Intent

Before doing anything, parse the user's input for:

1. **TOPIC**: What they want to learn about (e.g., "web app mockups", "Claude Code skills", "image generation")
2. **TARGET TOOL** (if specified): Where they'll use the prompts (e.g., "Nano Banana Pro", "ChatGPT", "Midjourney")
3. **QUERY TYPE**: What kind of research they want:
   - **PROMPTING** - "X prompts", "prompting for X", "X best practices" → User wants to learn techniques and get copy-paste prompts
   - **RECOMMENDATIONS** - "best X", "top X", "what X should I use", "recommended X" → User wants a LIST of specific things
   - **NEWS** - "what's happening with X", "X news", "latest on X" → User wants current events/updates
   - **COMPARISON** - "X vs Y", "X versus Y", "compare X and Y", "X or Y which is better" → User wants a side-by-side comparison
   - **GENERAL** - anything else → User wants broad understanding of the topic

Common patterns:
- `[topic] for [tool]` → "web mockups for Nano Banana Pro" → TOOL IS SPECIFIED
- `[topic] prompts for [tool]` → "UI design prompts for Midjourney" → TOOL IS SPECIFIED
- Just `[topic]` → "iOS design mockups" → TOOL NOT SPECIFIED, that's OK
- "best [topic]" or "top [topic]" → QUERY_TYPE = RECOMMENDATIONS
- "what are the best [topic]" → QUERY_TYPE = RECOMMENDATIONS
- "X vs Y" or "X versus Y" → QUERY_TYPE = COMPARISON, TOPIC_A = X, TOPIC_B = Y (split on ` vs ` or ` versus ` with spaces)

**IMPORTANT: Do NOT ask about target tool before research.**
- If tool is specified in the query, use it
- If tool is NOT specified, run research first, then ask AFTER showing results

**Store these variables:**
- `TOPIC = [extracted topic]`
- `TARGET_TOOL = [extracted tool, or "unknown" if not specified]`
- `QUERY_TYPE = [RECOMMENDATIONS | NEWS | HOW-TO | COMPARISON | GENERAL]`
- `TOPIC_A = [first item]` (only if COMPARISON)
- `TOPIC_B = [second item]` (only if COMPARISON)

**DISPLAY your parsing to the user.** Before running any tools, output:

```
I'll research {TOPIC} across Reddit, X, Bluesky, Truth Social, TikTok, and the web to find what's been discussed in the last 30 days.

Parsed intent:
- TOPIC = {TOPIC}
- TARGET_TOOL = {TARGET_TOOL or "unknown"}
- QUERY_TYPE = {QUERY_TYPE}

Research typically takes 2-8 minutes (niche topics take longer). Starting now.
```

If TARGET_TOOL is known, mention it in the intro: "...to find {QUERY_TYPE}-style content for use in {TARGET_TOOL}."

This text MUST appear before you call any tools. It confirms to the user that you understood their request.

---

## Step 0.5: Resolve X Handle (if topic could have an X account)

If TOPIC looks like it could have its own X/Twitter account - **people, creators, brands, products, tools, companies, communities** (e.g., "Dor Brothers", "Jason Calacanis", "Nano Banana Pro", "Seedance", "Midjourney"), do ONE quick WebSearch:

```
WebSearch("{TOPIC} X twitter handle site:x.com")
```

From the results, extract their X/Twitter handle. Look for:
- **Verified profile URLs** like `x.com/{handle}` or `twitter.com/{handle}`
- Mentions like "@handle" in bios, articles, or social profiles
- "Follow @handle on X" patterns

**Verify the account is real, not a parody/fan account.** Check for:
- Verified/blue checkmark in the search results
- Official website linking to the X account
- Consistent naming (e.g., @thedorbrothers for "The Dor Brothers", not @DorBrosFan)
- If results only show fan/parody/news accounts (not the entity's own account), skip - the entity may not have an X presence

If you find a clear, verified handle, pass it as `--x-handle={handle}` (without @). This searches that account's posts directly - finding content they posted that doesn't mention their own name.

**Skip this step if:**
- TOPIC is clearly a generic concept, not an entity (e.g., "best rap songs 2026", "how to use Docker", "AI ethics debate")
- TOPIC already contains @ (user provided the handle directly)
- Using `--quick` depth
- WebSearch shows no official X account exists for this entity

Store: `RESOLVED_HANDLE = {handle or empty}`

---

## Agent Mode (--agent flag)

If `--agent` appears in ARGUMENTS (e.g., `/last30days plaud granola --agent`):

1. **Skip** the intro display block ("I'll research X across Reddit...")
2. **Skip** any `AskUserQuestion` calls - use `TARGET_TOOL = "unknown"` if not specified
3. **Run** the research script and WebSearch exactly as normal
4. **Skip** the "WAIT FOR USER RESPONSE" pause
5. **Skip** the follow-up invitation ("I'm now an expert on X...")
6. **Output** the complete research report and stop - do not wait for further input

Agent mode saves raw research data to `~/Documents/Last30Days/` automatically via `--save-dir` (handled by the script, no extra tool calls).

Agent mode report format:

```
## Research Report: {TOPIC}
Generated: {date} | Sources: Reddit, X, Bluesky, Truth Social, YouTube, TikTok, HN, Polymarket, Web

### Key Findings
[3-5 bullet points, highest-signal insights with citations]

### What I learned
{The full "What I learned" synthesis from normal output}

### Stats
{The standard stats block}
```

---

## If QUERY_TYPE = COMPARISON

When the user asks "X vs Y", run THREE research passes in parallel:

**Pass 1 + 2 (parallel Bash calls):**
```bash
# Run BOTH of these as parallel Bash tool calls in a single message:
python3 "${SKILL_ROOT}/scripts/last30days.py" {TOPIC_A} --emit=compact --no-native-web --save-dir=~/Documents/Last30Days
python3 "${SKILL_ROOT}/scripts/last30days.py" {TOPIC_B} --emit=compact --no-native-web --save-dir=~/Documents/Last30Days
```

**Pass 3 (after passes 1+2 complete):**
```bash
python3 "${SKILL_ROOT}/scripts/last30days.py" "{TOPIC_A} vs {TOPIC_B}" --emit=compact --no-native-web --save-dir=~/Documents/Last30Days
```

Then do WebSearch for: `{TOPIC_A} vs {TOPIC_B} comparison 2026` and `{TOPIC_A} vs {TOPIC_B} which is better`.

**Skip the normal Step 1 below** - go directly to the comparison synthesis format (see "If QUERY_TYPE = COMPARISON" in the synthesis section).

---

## Research Execution

**Step 1: Run the research script (FOREGROUND — do NOT background this)**

**CRITICAL: Run this command in the FOREGROUND with a 5-minute timeout. Do NOT use run_in_background. The full output contains Reddit, X, AND YouTube data that you need to read completely.**

**IMPORTANT: The script handles API key/Codex auth detection automatically.** Run it and check the output to determine mode.

```bash
# Find skill root — works in repo checkout, Claude Code, or Codex install
for dir in \
  "." \
  "${CLAUDE_PLUGIN_ROOT:-}" \
  "${GEMINI_EXTENSION_DIR:-}" \
  "$HOME/.claude/plugins/marketplaces/last30days-skill" \
  "$HOME/.gemini/extensions/last30days-skill" \
  "$HOME/.gemini/extensions/last30days" \
  "$HOME/.claude/skills/last30days" \
  "$HOME/.agents/skills/last30days" \
  "$HOME/.codex/skills/last30days"; do
  [ -n "$dir" ] && [ -f "$dir/scripts/last30days.py" ] && SKILL_ROOT="$dir" && break
done

if [ -z "${SKILL_ROOT:-}" ]; then
  echo "ERROR: Could not find scripts/last30days.py" >&2
  exit 1
fi

python3 "${SKILL_ROOT}/scripts/last30days.py" $ARGUMENTS --emit=compact --no-native-web --save-dir=~/Documents/Last30Days  # Add --x-handle=HANDLE if RESOLVED_HANDLE is set
```

Use a **timeout of 300000** (5 minutes) on the Bash call. The script typically takes 1-3 minutes.

The script will automatically:
- Detect available API keys
- Run Reddit/X/YouTube/TikTok/Instagram/Hacker News/Polymarket searches
- Output ALL results including YouTube transcripts, TikTok captions, Instagram captions, HN comments, and prediction market odds

**Read the ENTIRE output.** It contains EIGHT data sections in this order: Reddit items, X items, YouTube items, TikTok items, Instagram Reels items, Hacker News items, Polymarket items, and WebSearch items. If you miss sections, you will produce incomplete stats.

**YouTube items in the output look like:** `**{video_id}** (score:N) {channel_name} [N views, N likes]` followed by a title, URL, and optional transcript snippet. Count them and include them in your synthesis and stats block.

**TikTok items in the output look like:** `**{TK_id}** (score:N) @{creator} [N views, N likes]` followed by a caption, URL, hashtags, and optional caption snippet. Count them and include them in your synthesis and stats block.

**Instagram Reels items in the output look like:** `**{IG_id}** (score:N) @{creator} (date) [N views, N likes]` followed by caption text, URL, and optional transcript. Count them and include them in your synthesis and stats block. Instagram provides unique creator/influencer perspective — weight it alongside TikTok.

---

## STEP 2: DO WEBSEARCH AFTER SCRIPT COMPLETES

After the script finishes, do WebSearch to supplement with blogs, tutorials, and news.

For **ALL modes**, do WebSearch to supplement (or provide all data in web-only mode).

Choose search queries based on QUERY_TYPE:

**If RECOMMENDATIONS** ("best X", "top X", "what X should I use"):
- Search for: `best {TOPIC} recommendations`
- Search for: `{TOPIC} list examples`
- Search for: `most popular {TOPIC}`
- Goal: Find SPECIFIC NAMES of things, not generic advice

**If NEWS** ("what's happening with X", "X news"):
- Search for: `{TOPIC} news 2026`
- Search for: `{TOPIC} announcement update`
- Goal: Find current events and recent developments

**If PROMPTING** ("X prompts", "prompting for X"):
- Search for: `{TOPIC} prompts examples 2026`
- Search for: `{TOPIC} techniques tips`
- Goal: Find prompting techniques and examples to create copy-paste prompts

**If GENERAL** (default):
- Search for: `{TOPIC} 2026`
- Search for: `{TOPIC} discussion`
- Goal: Find what people are actually saying

For ALL query types:
- **USE THE USER'S EXACT TERMINOLOGY** - don't substitute or add tech names based on your knowledge
- EXCLUDE reddit.com, x.com, twitter.com (covered by script)
- INCLUDE: blogs, tutorials, docs, news, GitHub repos
- **DO NOT output a separate "Sources:" block** — instead, include the top 3-5 web
  source names as inline links on the 🌐 Web: stats line (see stats format below).
  The WebSearch tool requires citation; satisfy it there, not as a trailing section.

**Options** (passed through from user's command):
- `--days=N` → Look back N days instead of 30 (e.g., `--days=7` for weekly roundup)
- `--quick` → Faster, fewer sources (8-12 each)
- (default) → Balanced (20-30 each)
- `--deep` → Comprehensive (50-70 Reddit, 40-60 X)

---

## Judge Agent: Synthesize All Sources

**After all searches complete, internally synthesize (don't display stats yet):**

The Judge Agent must:
1. Weight Reddit/X sources HIGHER (they have engagement signals: upvotes, likes)
2. Weight YouTube sources HIGH (they have views, likes, and transcript content)
3. Weight TikTok sources HIGH (they have views, likes, and caption content — viral signal)
4. Weight WebSearch sources LOWER (no engagement data)
5. **For Reddit: Pay special attention to top comments** — they often contain the wittiest, most insightful, or funniest take. When a top comment has high upvotes (shown as `💬 Top comment (N upvotes)`), quote it directly in your synthesis. Reddit's value is in the comments.
6. Identify patterns that appear across ALL sources (strongest signals)
7. Note any contradictions between sources
8. Extract the top 3-5 actionable insights

7. **Cross-platform signals are the strongest evidence.** When items have `[also on: Reddit, HN]` or similar tags, it means the same story appears across multiple platforms. Lead with these cross-platform findings - they're the most important signals in the research.

### Prediction Markets (Polymarket)

**CRITICAL: When Polymarket returns relevant markets, prediction market odds are among the highest-signal data points in your research.** Real money on outcomes cuts through opinion. Treat them as strong evidence, not an afterthought.

**How to interpret and synthesize Polymarket data:**

1. **Prefer structural/long-term markets over near-term deadlines.** Championship odds > regular season title. Regime change > near-term strike deadline. IPO/major milestone > incremental update. Presidency > individual state primary. When multiple markets exist, the bigger question is more interesting to the user.

2. **When the topic is an outcome in a multi-outcome market, call out that specific outcome's odds and movement.** Don't just say "Polymarket has a #1 seed market" - say "Arizona has a 28% chance of being the #1 overall seed, up 10% this month." The user cares about THEIR topic's position in the market.

3. **Weave odds into the narrative as supporting evidence.** Don't isolate Polymarket data in its own paragraph. Instead: "Final Four buzz is building - Polymarket gives Arizona a 12% chance to win the championship (up 3% this week), and 28% to earn a #1 seed."

4. **Citation format:** Always include specific odds AND movement. "Polymarket has Arizona at 28% for a #1 seed (up 10% this month)" - not just "per Polymarket."

5. **When multiple relevant markets exist, highlight 3-5 of the most interesting ones** in your synthesis, ordered by importance (structural > near-term). Don't just pick the highest-volume one.

**Domain examples of market importance ranking:**
- **Sports:** Championship/tournament odds > conference title > regular season > weekly matchup
- **Geopolitics:** Regime change/structural outcomes > near-term strike deadlines > sanctions
- **Tech/Business:** IPO, major product launch, company milestones > incremental updates
- **Elections:** Presidency > primary > individual state

**Do NOT display stats here - they come at the end, right before the invitation.**

---

## FIRST: Internalize the Research

**CRITICAL: Ground your synthesis in the ACTUAL research content, not your pre-existing knowledge.**

Read the research output carefully. Pay attention to:
- **Exact product/tool names** mentioned (e.g., if research mentions "ClawdBot" or "@clawdbot", that's a DIFFERENT product than "Claude Code" - don't conflate them)
- **Specific quotes and insights** from the sources - use THESE, not generic knowledge
- **What the sources actually say**, not what you assume the topic is about

**ANTI-PATTERN TO AVOID**: If user asks about "clawdbot skills" and research returns ClawdBot content (self-hosted AI agent), do NOT synthesize this as "Claude Code skills" just because both involve "skills". Read what the research actually says.

### If QUERY_TYPE = RECOMMENDATIONS

**CRITICAL: Extract SPECIFIC NAMES, not generic patterns.**

When user asks "best X" or "top X", they want a LIST of specific things:
- Scan research for specific product names, tool names, project names, skill names, etc.
- Count how many times each is mentioned
- Note which sources recommend each (Reddit thread, X post, blog)
- List them by popularity/mention count

**BAD synthesis for "best Claude Code skills":**
> "Skills are powerful. Keep them under 500 lines. Use progressive disclosure."

**GOOD synthesis for "best Claude Code skills":**
> "Most mentioned skills: /commit (5 mentions), remotion skill (4x), git-worktree (3x), /pr (3x). The Remotion announcement got 16K likes on X."

### If QUERY_TYPE = COMPARISON

Structure the output as a side-by-side comparison using data from all three research passes:

```
# {TOPIC_A} vs {TOPIC_B}: What the Community Says (Last 30 Days)

## Quick Verdict
[1-2 sentence data-driven summary: which one the community prefers and why, with source counts]

## {TOPIC_A}
**Community Sentiment:** [Positive/Mixed/Negative] ({N} mentions across {sources})

**Strengths (what people love)**
- [Point 1 with source attribution]
- [Point 2]

**Weaknesses (common complaints)**
- [Point 1 with source attribution]
- [Point 2]

## {TOPIC_B}
**Community Sentiment:** [Positive/Mixed/Negative] ({N} mentions across {sources})

**Strengths (what people love)**
- [Point 1 with source attribution]
- [Point 2]

**Weaknesses (common complaints)**
- [Point 1 with source attribution]
- [Point 2]

## Head-to-Head
[Synthesis from the "A vs B" combined search - what people say when directly comparing]

| Dimension | {TOPIC_A} | {TOPIC_B} |
|-----------|-----------|-----------|
| [Key dimension 1] | [A's position] | [B's position] |
| [Key dimension 2] | [A's position] | [B's position] |
| [Key dimension 3] | [A's position] | [B's position] |

## The Bottom Line
Choose {TOPIC_A} if... Choose {TOPIC_B} if... (based on actual community data, not assumptions)
```

Then show combined stats from all three passes and the standard invitation section.

### For all QUERY_TYPEs

Identify from the ACTUAL RESEARCH OUTPUT:
- **PROMPT FORMAT** - Does research recommend JSON, structured params, natural language, keywords?
- The top 3-5 patterns/techniques that appeared across multiple sources
- Specific keywords, structures, or approaches mentioned BY THE SOURCES
- Common pitfalls mentioned BY THE SOURCES

---

## THEN: Show Summary + Invite Vision

**Display in this EXACT sequence:**

**FIRST - What I learned (based on QUERY_TYPE):**

**If RECOMMENDATIONS** - Show specific things mentioned with sources:
```
🏆 Most mentioned:

[Tool Name] - {n}x mentions
Use Case: [what it does]
Sources: @handle1, @handle2, r/sub, blog.com

[Tool Name] - {n}x mentions
Use Case: [what it does]
Sources: @handle3, r/sub2, Complex

Notable mentions: [other specific things with 1-2 mentions]
```

**CRITICAL for RECOMMENDATIONS:**
- Each item MUST have a "Sources:" line with actual @handles from X posts (e.g., @LONGLIVE47, @ByDobson)
- Include subreddit names (r/hiphopheads) and web sources (Complex, Variety)
- Parse @handles from research output and include the highest-engagement ones
- Format naturally - tables work well for wide terminals, stacked cards for narrow

**If PROMPTING/NEWS/GENERAL** - Show synthesis and patterns:

CITATION RULE: Cite sources sparingly to prove research is real.
- In the "What I learned" intro: cite 1-2 top sources total, not every sentence
- In KEY PATTERNS: cite 1 source per pattern, short format: "per @handle" or "per r/sub"
- Do NOT include engagement metrics in citations (likes, upvotes) - save those for stats box
- Do NOT chain multiple citations: "per @x, @y, @z" is too much. Pick the strongest one.

CITATION PRIORITY (most to least preferred):
1. @handles from X — "per @handle" (these prove the tool's unique value)
2. r/subreddits from Reddit — "per r/subreddit" (when citing Reddit, prefer quoting top comments over just the thread title)
3. YouTube channels — "per [channel name] on YouTube" (transcript-backed insights)
4. TikTok creators — "per @creator on TikTok" (viral/trending signal)
5. Instagram creators — "per @creator on Instagram" (influencer/creator signal)
6. HN discussions — "per HN" or "per hn/username" (developer community signal)
7. Polymarket — "Polymarket has X at Y% (up/down Z%)" with specific odds and movement
8. Web sources — ONLY when Reddit/X/YouTube/TikTok/Instagram/HN/Polymarket don't cover that specific fact

The tool's value is surfacing what PEOPLE are saying, not what journalists wrote.
When both a web article and an X post cover the same fact, cite the X post.

URL FORMATTING: NEVER paste raw URLs anywhere in the output — not in synthesis, not in stats, not in sources.
- **BAD:** "per https://www.rollingstone.com/music/music-news/kanye-west-bully-1235506094/"
- **GOOD:** "per Rolling Stone"
- **BAD stats line:** `🌐 Web: 10 pages — https://later.com/blog/..., https://buffer.com/...`
- **GOOD stats line:** `🌐 Web: 10 pages — Later, Buffer, CNN, SocialBee`
Use the publication/site name, not the URL. The user doesn't need links — they need clean, readable text.

**BAD:** "His album is set for March 20 (per Rolling Stone; Billboard; Complex)."
**GOOD:** "His album BULLY drops March 20 — fans on X are split on the tracklist, per @honest30bgfan_"
**GOOD:** "Ye's apology got massive traction on r/hiphopheads"
**OK** (web, only when Reddit/X don't have it): "The Hellwatt Festival runs July 4-18 at RCF Arena, per Billboard"

**Lead with people, not publications.** Start each topic with what Reddit/X
users are saying/feeling, then add web context only if needed. The user came
here for the conversation, not the press release.

```
What I learned:

**{Topic 1}** — [1-2 sentences about what people are saying, per @handle or r/sub]

**{Topic 2}** — [1-2 sentences, per @handle or r/sub]

**{Topic 3}** — [1-2 sentences, per @handle or r/sub]

KEY PATTERNS from the research:
1. [Pattern] — per @handle
2. [Pattern] — per r/sub
3. [Pattern] — per @handle
```

**THEN - Stats (right before invitation):**

**CRITICAL: Calculate actual totals from the research output.**
- Count posts/threads from each section
- Sum engagement: parse `[Xlikes, Yrt]` from each X post, `[Xpts, Ycmt]` from Reddit
- Identify top voices: highest-engagement @handles from X, most active subreddits

**Copy this EXACTLY, replacing only the {placeholders}:**

```
---
✅ All agents reported back!
├─ 🟠 Reddit: {N} threads │ {N} upvotes │ {N} comments
├─ 🔵 X: {N} posts │ {N} likes │ {N} reposts
├─ 🔴 YouTube: {N} videos │ {N} views │ {N} with transcripts
├─ 🎵 TikTok: {N} videos │ {N} views │ {N} likes │ {N} with captions
├─ 📸 Instagram: {N} reels │ {N} views │ {N} likes │ {N} with captions
├─ 🟡 HN: {N} stories │ {N} points │ {N} comments
├─ 🦋 Bluesky: {N} posts │ {N} likes │ {N} reposts
├─ 🇺🇸 Truth Social: {N} posts │ {N} likes │ {N} reposts
├─ 📊 Polymarket: {N} markets │ {short summary of up to 5 most relevant market odds, e.g. "Championship: 12%, #1 Seed: 28%, Big 12: 64%, vs Kansas: 71%"}
├─ 🌐 Web: {N} pages — Source Name, Source Name, Source Name
└─ 🗣️ Top voices: @{handle1} ({N} likes), @{handle2} │ r/{sub1}, r/{sub2}
---
```

**🌐 Web: line — how to extract site names from URLs:**
Strip the protocol, path, and `www.` — use the recognizable publication name:
- `https://later.com/blog/instagram-reels-trends/` → **Later**
- `https://socialbee.com/blog/instagram-trends/` → **SocialBee**
- `https://buffer.com/resources/instagram-algorithms/` → **Buffer**
- `https://www.cnn.com/2026/02/22/tech/...` → **CNN**
- `https://medium.com/the-ai-studio/...` → **Medium**
- `https://radicaldatascience.wordpress.com/...` → **Radical Data Science**
List as comma-separated plain names: `Later, SocialBee, Buffer, CNN, Medium`

**⚠️ WebSearch citation — ALREADY SATISFIED. DO NOT ADD A SOURCES SECTION.**
The WebSearch tool mandates source citation. That requirement is FULLY satisfied by the source names on the 🌐 Web: line above. Do NOT append a separate "Sources:" section at the end of your response. Do NOT list URLs anywhere. The 🌐 Web: line IS your citation. Nothing more is needed.

**CRITICAL: Omit any source line that returned 0 results.** Do NOT show "0 threads", "0 stories", "0 markets", or "(no results this cycle)". If a source found nothing, DELETE that line entirely - don't include it at all.
NEVER use plain text dashes (-) or pipe (|). ALWAYS use ├─ └─ │ and the emoji.

**SELF-CHECK before displaying**: Re-read your "What I learned" section. Does it match what the research ACTUALLY says? If you catch yourself projecting your own knowledge instead of the research, rewrite it.

**LAST - Invitation (adapt to QUERY_TYPE):**

**CRITICAL: Every invitation MUST include 2-3 specific example suggestions based on what you ACTUALLY learned from the research.** Don't be generic — show the user you absorbed the content by referencing real things from the results.

**If QUERY_TYPE = PROMPTING:**
```
---
I'm now an expert on {TOPIC} for {TARGET_TOOL}. What do you want to make? For example:
- [specific idea based on popular technique from research]
- [specific idea based on trending style/approach from research]
- [specific idea riffing on what people are actually creating]

Just describe your vision and I'll write a prompt you can paste straight into {TARGET_TOOL}.
```

**If QUERY_TYPE = RECOMMENDATIONS:**
```
---
I'm now an expert on {TOPIC}. Want me to go deeper? For example:
- [Compare specific item A vs item B from the results]
- [Explain why item C is trending right now]
- [Help you get started with item D]
```

**If QUERY_TYPE = NEWS:**
```
---
I'm now an expert on {TOPIC}. Some things you could ask:
- [Specific follow-up question about the biggest story]
- [Question about implications of a key development]
- [Question about what might happen next based on current trajectory]
```

**If QUERY_TYPE = COMPARISON:**
```
---
I've compared {TOPIC_A} vs {TOPIC_B} using the latest community data. Some things you could ask:
- [Deep dive into {TOPIC_A} alone with /last30days {TOPIC_A}]
- [Deep dive into {TOPIC_B} alone with /last30days {TOPIC_B}]
- [Focus on a specific dimension from the comparison table]
- [Look at a different time period with --days=7 or --days=90]
```

**If QUERY_TYPE = GENERAL:**
```
---
I'm now an expert on {TOPIC}. Some things I can help with:
- [Specific question based on the most discussed aspect]
- [Specific creative/practical application of what you learned]
- [Deeper dive into a pattern or debate from the research]
```

**Example invitations (to show the quality bar):**

For `/last30days nano banana pro prompts for Gemini`:
> I'm now an expert on Nano Banana Pro for Gemini. What do you want to make? For example:
> - Photorealistic product shots with natural lighting (the most requested style right now)
> - Logo designs with embedded text (Gemini's new strength per the research)
> - Multi-reference style transfer from a mood board
>
> Just describe your vision and I'll write a prompt you can paste straight into Gemini.

For `/last30days kanye west` (GENERAL):
> I'm now an expert on Kanye West. Some things I can help with:
> - What's the real story behind the apology letter — genuine or PR move?
> - Break down the BULLY tracklist reactions and what fans are expecting
> - Compare how Reddit vs X are reacting to the Bianca narrative

For `/last30days war in Iran` (NEWS):
> I'm now an expert on the Iran situation. Some things you could ask:
> - What are the realistic escalation scenarios from here?
> - How is this playing differently in US vs international media?
> - What's the economic impact on oil markets so far?

---

## WAIT FOR USER'S RESPONSE

**STOP and wait** for the user to respond. Do NOT call any tools after displaying the invitation. The research script already saved raw data to `~/Documents/Last30Days/` via `--save-dir`.

---

## WHEN USER RESPONDS

**Read their response and match the intent:**

- If they ask a **QUESTION** about the topic → Answer from your research (no new searches, no prompt)
- If they ask to **GO DEEPER** on a subtopic → Elaborate using your research findings
- If they describe something they want to **CREATE** → Write ONE perfect prompt (see below)
- If they ask for a **PROMPT** explicitly → Write ONE perfect prompt (see below)

**Only write a prompt when the user wants one.** Don't force a prompt on someone who asked "what could happen next with Iran."

### Writing a Prompt

When the user wants a prompt, write a **single, highly-tailored prompt** using your research expertise.

### CRITICAL: Match the FORMAT the research recommends

**If research says to use a specific prompt FORMAT, YOU MUST USE THAT FORMAT.**

**ANTI-PATTERN**: Research says "use JSON prompts with device specs" but you write plain prose. This defeats the entire purpose of the research.

### Quality Checklist (run before delivering):
- [ ] **FORMAT MATCHES RESEARCH** - If research said JSON/structured/etc, prompt IS that format
- [ ] Directly addresses what the user said they want to create
- [ ] Uses specific patterns/keywords discovered in research
- [ ] Ready to paste with zero edits (or minimal [PLACEHOLDERS] clearly marked)
- [ ] Appropriate length and style for TARGET_TOOL

### Output Format:

```
Here's your prompt for {TARGET_TOOL}:

---

[The actual prompt IN THE FORMAT THE RESEARCH RECOMMENDS]

---

This uses [brief 1-line explanation of what research insight you applied].
```

---

## IF USER ASKS FOR MORE OPTIONS

Only if they ask for alternatives or more prompts, provide 2-3 variations. Don't dump a prompt pack unless requested.

---

## AFTER EACH PROMPT: Stay in Expert Mode

After delivering a prompt, offer to write more:

> Want another prompt? Just tell me what you're creating next.

---

## CONTEXT MEMORY

For the rest of this conversation, remember:
- **TOPIC**: {topic}
- **TARGET_TOOL**: {tool}
- **KEY PATTERNS**: {list the top 3-5 patterns you learned}
- **RESEARCH FINDINGS**: The key facts and insights from the research

**CRITICAL: After research is complete, treat yourself as an EXPERT on this topic.**

When the user asks follow-up questions:
- **DO NOT run new WebSearches** - you already have the research
- **Answer from what you learned** - cite the Reddit threads, X posts, and web sources
- **If they ask a question** - answer it from your research findings
- **If they ask for a prompt** - write one using your expertise

Only do new research if the user explicitly asks about a DIFFERENT topic.

---

## Output Summary Footer (After Each Prompt)

After delivering a prompt, end with:

```
---
📚 Expert in: {TOPIC} for {TARGET_TOOL}
📊 Based on: {n} Reddit threads ({sum} upvotes) + {n} X posts ({sum} likes) + {n} YouTube videos ({sum} views) + {n} TikTok videos ({sum} views) + {n} Instagram reels ({sum} views) + {n} HN stories ({sum} points) + {n} web pages

Want another prompt? Just tell me what you're creating next.
```

---

## Security & Permissions

**What this skill does:**
- Sends search queries to ScrapeCreators API (`api.scrapecreators.com`) for Reddit search, subreddit discovery, and comment enrichment (requires SCRAPECREATORS_API_KEY — same key as TikTok + Instagram)
- Legacy: Sends search queries to OpenAI's Responses API (`api.openai.com`) for Reddit discovery (fallback if no SCRAPECREATORS_API_KEY)
- Sends search queries to Twitter's GraphQL API (via optional user-provided AUTH_TOKEN/CT0 env vars — no browser session access) or xAI's API (`api.x.ai`) for X search
- Sends search queries to Algolia HN Search API (`hn.algolia.com`) for Hacker News story and comment discovery (free, no auth)
- Sends search queries to Polymarket Gamma API (`gamma-api.polymarket.com`) for prediction market discovery (free, no auth)
- Runs `yt-dlp` locally for YouTube search and transcript extraction (no API key, public data)
- Sends search queries to ScrapeCreators API (`api.scrapecreators.com`) for TikTok and Instagram search, transcript/caption extraction (same SCRAPECREATORS_API_KEY as Reddit, PAYG after 100 free credits)
- Optionally sends search queries to Brave Search API, Parallel AI API, or OpenRouter API for web search
- Fetches public Reddit thread data from `reddit.com` for engagement metrics
- Stores research findings in local SQLite database (watchlist mode only)
- Saves research briefings as .md files to ~/Documents/Last30Days/

**What this skill does NOT do:**
- Does not post, like, or modify content on any platform
- Does not access your Reddit, X, or YouTube accounts
- Does not share API keys between providers (OpenAI key only goes to api.openai.com, etc.)
- Does not log, cache, or write API keys to output files
- Does not send data to any endpoint not listed above
- Hacker News and Polymarket sources are always available (no API key, no binary dependency)
- TikTok and Instagram sources require SCRAPECREATORS_API_KEY (same key covers both; 100 free credits, then PAYG)
- Can be invoked autonomously by agents via the Skill tool (runs inline, not forked); pass `--agent` for non-interactive report output

**Bundled scripts:** `scripts/last30days.py` (main research engine), `scripts/lib/` (search, enrichment, rendering modules), `scripts/lib/vendor/bird-search/` (vendored X search client, MIT licensed)

Review scripts before first use to verify behavior.
