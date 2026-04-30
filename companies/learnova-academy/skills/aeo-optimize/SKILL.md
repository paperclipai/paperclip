---
name: aeo-optimize
description: >
  SEO Optimizer's Answer Engine Optimization skill — make pages directly
  answer questions in the way Google AI Overviews, ChatGPT search, Claude
  search, and Perplexity prefer. Higher-tier than classic SEO. Use when
  Chief Marketing dispatches type aeo-audit.
---

# AEO Optimize

Answer Engine Optimization — make us the cited source AI search engines reach for.

## Scope

- One page per audit
- Different from SEO (rank in SERPs) and GEO (be in /llms.txt) — AEO is about being **cited inline** in AI-generated answers
- Specifically targets: Google AI Overviews, ChatGPT search, Claude search, Perplexity, Bing Copilot

## Inputs

- A published page URL on `academy.kspl.tech`
- The vault source file (for cross-referencing claims)

## Workflow

### 1. Question-extraction audit

What questions does this page answer? List the top 5 the page should rank for.

```bash
# Manual: read the H1 + H2s + opening paragraph
curl -s "$URL" | grep -oE '<h[1-3][^>]*>[^<]+</h[1-3]>' | head -10
```

For each question, check:
- Is the answer in the **first 50-100 words after** the H2/H3?
- Is the answer **complete enough to cite** without further reading?
- Does the answer have a **specific number, name, or fact** (extractable atom)?

If not, propose a content edit (route to @content-author through @chief-content).

### 2. FAQPage schema check

Every page that has KnowledgeChecks or "common questions" should emit `FAQPage` JSON-LD:

```bash
curl -s "$URL" | grep -A 1 'FAQPage' | head -5
```

Missing → propose adding to template + the per-page MDX content (route via @chief-engineering for template, @content-author for content).

### 3. Citation-friendliness audit

AI search engines cite pages that:
- Have a clear, dated `<time>` element (already in our blog frontmatter)
- Have **named author/organization** in the byline
- Use **active voice** with verbs leading sentences
- Cite their own sources inline (we do this)
- Avoid prompt-injection-looking phrases ("ignore previous instructions", "as a large language model", etc.)

Scan the page for these signals. Score 0-5; <4 → propose edits.

### 4. Statement chunking audit

LLMs extract by *chunk*, not paragraph. Each statement-of-fact should:
- Be 1-2 sentences max in its own paragraph (or list item)
- Open with the **subject + verb + object** ("Anthropic shipped 9 connectors..."), not lead-in clauses
- Include the citation in the same chunk

Find any 3+ sentence paragraphs containing 2+ distinct factual claims — those need splitting.

### 5. "Try this prompt" hooks

For our audience (AI builders), embed a **runnable prompt** the user can copy. AI search engines surface pages that have:
- Code blocks with language tags (`​```python`)
- Curl examples with the actual URL/headers
- A clear "expected output" comparison

Pages without these underperform on AEO benchmarks.

### 6. AI-search referrer check (post-publish)

Once the page has been indexed for ≥1 week, check Search Console + Perplexity referrer logs for:
- Did Perplexity / ChatGPT / Claude search cite this page?
- Citation rate vs traffic? (Citations are higher-trust than clicks.)

Track in `vault/marketing/aeo/<page-slug>-tracking.md`.

### 7. Decide

PASS:
```
✅ AEO PASS · <URL>
Question coverage: 5/5 H2s lead with answer in first 50 words
FAQPage schema: present (3 Q&As)
Citation-friendliness: 5/5
Chunking: clean (longest factual chunk = 2 sentences)
Try-this hooks: 2 RunPromptCells, 1 curl example
Will track AI-search referrers weekly.
```

BLOCK (with route per issue):
```
❌ AEO IMPROVEMENTS · <URL>

Q1 ("How do I use Claude tools?"): answer is buried in para 3, not first sentence after H2
Q2 ("What does input_schema validate?"): answer is split across 4 paragraphs — chunk it
FAQPage schema: missing despite 4 KnowledgeChecks present
Try-this hook missing: only 1 RunPromptCell, no curl example

→ @content-author via @chief-content (revise structure)
→ @chief-engineering (add FAQPage schema generation to blog template)
```

## Output

PASS/BLOCK comment + `vault/marketing/aeo/<page-slug>.md` audit record.

## Notes

- AEO ≠ SEO. A page can rank well on Google but never get cited by AI search.
- The 2026 SpamBrain update favors "answer-first" content — this is now SEO + AEO converged.
- Per-task cap $0.40.

## Escalation

- Same chunking issue across 3+ posts → propose course-author skill update (chunking discipline)
- Schema regression on multiple pages → propose chief-engineering template fix
- AI-search citation rate dropping >20% week-over-week → escalate CEO

## References

- Google AI Overview ranking signals (2026 update)
- llmstxt.org best practices
- Perplexity citation guidelines
