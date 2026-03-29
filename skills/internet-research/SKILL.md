---
name: internet-research
description: Use when agent needs to access internet content — web pages, YouTube, RSS feeds, GitHub repos, social media. Provides unified methods for fetching and processing online information.
---

# Internet Research Skill

Based on agent-reach patterns for accessing internet content.

## Capabilities

### Built-in (No Config Required)
| Source | Method | Notes |
|---|---|---|
| Web pages | Jina Reader (`r.jina.ai/{url}`) | Returns clean markdown |
| YouTube | `yt-dlp --write-subs --skip-download` | Extracts subtitles/transcripts |
| RSS/Atom | Standard feed parsers | Any feed URL |
| GitHub repos | GitHub API or raw content | Public repos |

### With API Keys
| Source | Method | Config |
|---|---|---|
| Twitter/X | bird CLI or API | Bearer token |
| Reddit | Reddit API + Exa | API credentials |
| LinkedIn | Exa search | Exa API key |

## Usage Patterns

### Web Research
```bash
# Fetch clean content from any URL
curl -s "https://r.jina.ai/https://example.com" | head -500

# Search with Exa (if configured)
exa search "query" --type auto --num-results 10
```

### YouTube Research
```bash
# Get transcript
yt-dlp --write-auto-subs --sub-lang en --skip-download -o "%(title)s" "VIDEO_URL"
cat "*.vtt" | grep -v "^[0-9]" | grep -v "^$" | grep -v "WEBVTT"
```

### RSS Monitoring
```bash
# Fetch and parse RSS
curl -s "FEED_URL" | xmllint --xpath "//item/title/text()" -
```

## Best Practices
1. **Rate limiting**: Wait 1-2s between requests to the same domain
2. **Caching**: Store fetched content locally to avoid redundant requests
3. **Summarization**: For long content, extract key sections before processing
4. **Attribution**: Always cite sources with URLs
5. **Freshness**: Check publication dates — prefer recent content
