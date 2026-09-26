#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
UI/UX Pro Max Core - BM25 search engine for UI/UX style guides
"""

import csv
import re
from pathlib import Path
from math import log
from collections import defaultdict

# ============ CONFIGURATION ============
DATA_DIR = Path(__file__).parent.parent / "data"
MAX_RESULTS = 3

CSV_CONFIG = {
    "style": {
        "file": "styles.csv",
        "search_cols": ["Style Category", "Keywords", "Best For", "Type", "AI Prompt Keywords"],
        "output_cols": ["Style Category", "Type", "Keywords", "Primary Colors", "Effects & Animation", "Best For", "Light Mode ✓", "Dark Mode ✓", "Performance", "Accessibility", "Framework Compatibility", "Complexity", "AI Prompt Keywords", "CSS/Technical Keywords", "Implementation Checklist", "Design System Variables"]
    },
    "color": {
        "file": "colors.csv",
        "search_cols": ["Product Type", "Notes"],
        "output_cols": ["Product Type", "Primary", "On Primary", "Secondary", "On Secondary", "Accent", "On Accent", "Background", "Foreground", "Card", "Card Foreground", "Muted", "Muted Foreground", "Border", "Destructive", "On Destructive", "Ring", "Notes"]
    },
    "chart": {
        "file": "charts.csv",
        "search_cols": ["Data Type", "Keywords", "Best Chart Type", "When to Use", "When NOT to Use", "Accessibility Notes"],
        "output_cols": ["Data Type", "Keywords", "Best Chart Type", "Secondary Options", "When to Use", "When NOT to Use", "Data Volume Threshold", "Color Guidance", "Accessibility Grade", "Accessibility Notes", "A11y Fallback", "Library Recommendation", "Interactive Level"]
    },
    "landing": {
        "file": "landing.csv",
        "search_cols": ["Pattern Name", "Keywords", "Conversion Optimization", "Section Order"],
        "output_cols": ["Pattern Name", "Keywords", "Section Order", "Primary CTA Placement", "Color Strategy", "Conversion Optimization"]
    },
    "product": {
        "file": "products.csv",
        "search_cols": ["Product Type", "Keywords", "Primary Style Recommendation", "Key Considerations"],
        "output_cols": ["Product Type", "Keywords", "Primary Style Recommendation", "Secondary Styles", "Landing Page Pattern", "Dashboard Style (if applicable)", "Color Palette Focus"]
    },
    "ux": {
        "file": "ux-guidelines.csv",
        "search_cols": ["Category", "Issue", "Description", "Platform"],
        "output_cols": ["Category", "Issue", "Platform", "Description", "Do", "Don't", "Code Example Good", "Code Example Bad", "Severity"]
    },
    "typography": {
        "file": "typography.csv",
        "search_cols": ["Font Pairing Name", "Category", "Mood/Style Keywords", "Best For", "Heading Font", "Body Font"],
        "output_cols": ["Font Pairing Name", "Category", "Heading Font", "Body Font", "Mood/Style Keywords", "Best For", "Google Fonts URL", "CSS Import", "Tailwind Config", "Notes"]
    },
    "icons": {
        "file": "icons.csv",
        "search_cols": ["Category", "Icon Name", "Keywords", "Best For"],
        "output_cols": ["Category", "Icon Name", "Keywords", "Library", "Import Code", "Usage", "Best For", "Style"]
    },
    "gsap": {
        "file": "motion.csv",
        "search_cols": ["Category", "Intensity Tier", "Keywords", "Trigger"],
        "output_cols": ["Category", "Intensity Tier", "Trigger", "Duration", "Easing", "GSAP Snippet", "Framework Notes", "Do", "Don't", "Performance Notes"]
    },
    "react": {
        "file": "react-performance.csv",
        "search_cols": ["Category", "Issue", "Keywords", "Description"],
        "output_cols": ["Category", "Issue", "Platform", "Description", "Do", "Don't", "Code Example Good", "Code Example Bad", "Severity"]
    },
    "web": {
        "file": "app-interface.csv",
        "search_cols": ["Category", "Issue", "Keywords", "Description"],
        "output_cols": ["Category", "Issue", "Platform", "Description", "Do", "Don't", "Code Example Good", "Code Example Bad", "Severity"]
    },
    "google-fonts": {
        "file": "google-fonts.csv",
        "search_cols": ["Family", "Category", "Stroke", "Classifications", "Keywords", "Subsets", "Designers"],
        "output_cols": ["Family", "Category", "Stroke", "Classifications", "Styles", "Variable Axes", "Subsets", "Designers", "Popularity Rank", "Google Fonts URL"]
    }
}

# Output columns whose content (code samples, checklists) must never be
# hard-truncated for display -- truncating mid-snippet destroys the value.
UNTRUNCATED_COLS = {
    "Code Example Good", "Code Example Bad", "Code Good", "Code Bad",
    "Implementation Checklist", "Design System Variables", "CSS Import",
    "Tailwind Config", "GSAP Snippet",
}

STACK_CONFIG = {
    "react":            {"file": "stacks/react.csv"},
    "nextjs":           {"file": "stacks/nextjs.csv"},
    "vue":              {"file": "stacks/vue.csv"},
    "svelte":           {"file": "stacks/svelte.csv"},
    "astro":            {"file": "stacks/astro.csv"},
    "swiftui":          {"file": "stacks/swiftui.csv"},
    "react-native":     {"file": "stacks/react-native.csv"},
    "flutter":          {"file": "stacks/flutter.csv"},
    "nuxtjs":           {"file": "stacks/nuxtjs.csv"},
    "nuxt-ui":          {"file": "stacks/nuxt-ui.csv"},
    "html-tailwind":    {"file": "stacks/html-tailwind.csv"},
    "shadcn":           {"file": "stacks/shadcn.csv"},
    "jetpack-compose":  {"file": "stacks/jetpack-compose.csv"},
    "threejs":          {"file": "stacks/threejs.csv"},
    "angular":          {"file": "stacks/angular.csv"},
    "laravel":          {"file": "stacks/laravel.csv"},
    "javafx":           {"file": "stacks/javafx.csv"},
    "wpf":              {"file": "stacks/wpf.csv"},
    "winui":            {"file": "stacks/winui.csv"},
    "avalonia":         {"file": "stacks/avalonia.csv"},
    "uno":              {"file": "stacks/uno.csv"},
    "uwp":              {"file": "stacks/uwp.csv"},
}

# Common columns for all stacks
_STACK_COLS = {
    "search_cols": ["Category", "Guideline", "Description", "Do", "Don't"],
    "output_cols": ["Category", "Guideline", "Description", "Do", "Don't", "Code Good", "Code Bad", "Severity", "Docs URL"]
}

AVAILABLE_STACKS = list(STACK_CONFIG.keys())


# ============ TOKENIZATION ============
# Common two-letter/three-letter words that add noise without adding search
# signal. Deliberately short -- domain-relevant short tokens (ui, ux, ai,
# css, 3d, js, os, md, gsap) must stay searchable, which is why we don't
# filter purely by length.
_STOPWORDS = {
    "to", "in", "on", "at", "is", "of", "by", "or", "an", "if", "no", "so",
    "do", "be", "we", "it", "as", "the", "and", "for", "are", "was",
}

# Query/corpus normalization so common spelling variants match each other.
# Keep this a plain dict (stdlib only, no fuzzy-matching dependency).
_SYNONYMS = {
    "e-commerce": "ecommerce",
    "dark-mode": "dark",
    "darkmode": "dark",
    "light-mode": "light",
    "lightmode": "light",
    "a11y": "accessibility",
    "nav": "navigation",
    "sign-up": "signup",
    "log-in": "login",
    "colour": "color",
    "colours": "colors",
    "customisation": "customization",
    "organisation": "organization",
    "behaviour": "behavior",
    "ux/ui": "ux ui",
}


def _normalize(text):
    """Apply synonym substitution before tokenizing."""
    for variant, canonical in _SYNONYMS.items():
        text = text.replace(variant, canonical)
    return text


# ============ BM25 IMPLEMENTATION ============
class BM25:
    """BM25 ranking algorithm for text search"""

    def __init__(self, k1=1.5, b=0.75):
        self.k1 = k1
        self.b = b
        self.corpus = []
        self.doc_lengths = []
        self.avgdl = 0
        self.idf = {}
        self.doc_freqs = defaultdict(int)
        self.N = 0
        self._term_freqs = []  # precomputed per-doc term frequencies

    def tokenize(self, text):
        """Lowercase, normalize synonyms, split, remove punctuation, filter stopwords"""
        text = _normalize(str(text).lower())
        text = re.sub(r'[^\w\s]', ' ', text)
        return [w for w in text.split() if len(w) >= 2 and w not in _STOPWORDS]

    def fit(self, documents):
        """Build BM25 index from documents"""
        self.corpus = [self.tokenize(doc) for doc in documents]
        self.N = len(self.corpus)
        if self.N == 0:
            return
        self.doc_lengths = [len(doc) for doc in self.corpus]
        self.avgdl = sum(self.doc_lengths) / self.N

        self._term_freqs = []
        for doc in self.corpus:
            tf = defaultdict(int)
            for word in doc:
                tf[word] += 1
            self._term_freqs.append(tf)
            for word in tf:
                self.doc_freqs[word] += 1

        for word, freq in self.doc_freqs.items():
            self.idf[word] = log((self.N - freq + 0.5) / (freq + 0.5) + 1)

    def score(self, query):
        """Score all documents against query"""
        query_tokens = self.tokenize(query)
        scores = []

        for idx in range(self.N):
            score = 0
            doc_len = self.doc_lengths[idx]
            term_freqs = self._term_freqs[idx]

            for token in query_tokens:
                if token in self.idf:
                    tf = term_freqs.get(token, 0)
                    idf = self.idf[token]
                    numerator = tf * (self.k1 + 1)
                    denominator = tf + self.k1 * (1 - self.b + self.b * doc_len / self.avgdl)
                    score += idf * numerator / denominator

            scores.append((idx, score))

        return sorted(scores, key=lambda x: x[1], reverse=True)

    def vocabulary(self):
        """All indexed terms, for suggestion/typo-recovery purposes."""
        return list(self.idf.keys())


# ============ CSV / INDEX CACHE ============
# Data files are small and reused across multiple domain searches within a
# single --design-system run; avoid re-reading + re-indexing the same file
# repeatedly in one process.
_csv_cache = {}   # filepath -> (mtime, rows)
_bm25_cache = {}  # (filepath, tuple(search_cols)) -> (mtime, BM25 instance)


def _load_csv(filepath):
    """Load CSV and return list of dicts, with mtime-based caching."""
    mtime = filepath.stat().st_mtime
    cached = _csv_cache.get(filepath)
    if cached and cached[0] == mtime:
        return cached[1]

    with open(filepath, 'r', encoding='utf-8') as f:
        rows = list(csv.DictReader(f))

    _csv_cache[filepath] = (mtime, rows)
    return rows


def _get_bm25(filepath, search_cols, data):
    """Fitted BM25 index for this file+columns, with mtime-based caching."""
    key = (filepath, tuple(search_cols))
    mtime = filepath.stat().st_mtime
    cached = _bm25_cache.get(key)
    if cached and cached[0] == mtime:
        return cached[1]

    documents = [" ".join(str(row.get(col, "")) for col in search_cols) for row in data]
    bm25 = BM25()
    bm25.fit(documents)
    _bm25_cache[key] = (mtime, bm25)
    return bm25


# ============ SEARCH FUNCTIONS ============
def _search_csv(filepath, search_cols, output_cols, query, max_results):
    """Core search function using BM25. Returns (results, bm25_or_none)."""
    if not filepath.exists():
        return [], None

    try:
        data = _load_csv(filepath)
    except (csv.Error, OSError, UnicodeDecodeError) as e:
        return [{"_error": f"Failed to read {filepath.name}: {e}"}], None

    if not data:
        return [], None

    bm25 = _get_bm25(filepath, search_cols, data)
    ranked = bm25.score(query)

    results = []
    for idx, score in ranked[:max_results]:
        if score > 0:
            row = data[idx]
            results.append({col: row.get(col, "") for col in output_cols if col in row})

    return results, bm25


def _suggest_terms(bm25, query, limit=6):
    """Nearest known vocabulary terms for a query that returned 0 hits,
    so the caller can retry instead of silently reporting nothing."""
    if bm25 is None:
        return []
    query_tokens = set(bm25.tokenize(query))
    if not query_tokens:
        return []

    candidates = []
    for term in bm25.vocabulary():
        for qt in query_tokens:
            if term.startswith(qt[:3]) or qt.startswith(term[:3]):
                candidates.append(term)
                break

    # Stable de-dup, most frequent terms first (doc_freqs available via idf keys only,
    # so just de-dup preserving discovery order).
    seen = set()
    ordered = []
    for term in candidates:
        if term not in seen:
            seen.add(term)
            ordered.append(term)
    return ordered[:limit]


# Load the product-domain keyword list from products.csv at import time so
# it stays in sync with the data instead of needing manual updates to a
# hardcoded list. Falls back to a small built-in seed if the file is
# missing (e.g. package built without data/).
def _load_product_keywords():
    seed = ["saas", "ecommerce", "e-commerce", "fintech", "healthcare", "gaming",
            "portfolio", "crypto", "dashboard", "fitness", "marketplace"]
    filepath = DATA_DIR / CSV_CONFIG["product"]["file"]
    if not filepath.exists():
        return seed
    try:
        rows = _load_csv(filepath)
    except (csv.Error, OSError, UnicodeDecodeError):
        return seed

    keywords = set(seed)
    for row in rows:
        raw = row.get("Keywords", "")
        for kw in re.split(r"[,;]", raw):
            kw = kw.strip().lower()
            if kw and len(kw) >= 3:
                keywords.add(kw)
    return sorted(keywords, key=len, reverse=True)


_DOMAIN_KEYWORDS = None


def _domain_keywords():
    global _DOMAIN_KEYWORDS
    if _DOMAIN_KEYWORDS is not None:
        return _DOMAIN_KEYWORDS

    _DOMAIN_KEYWORDS = {
        "color": ["color", "palette", "hex", "#", "rgb", "token", "semantic", "accent", "destructive", "muted", "foreground"],
        "chart": ["chart", "graph", "visualization", "trend", "bar", "pie", "scatter", "heatmap", "funnel"],
        "landing": ["landing", "page", "cta", "conversion", "hero", "testimonial", "pricing", "section"],
        "product": _load_product_keywords(),
        "style": ["style", "design", "ui", "minimalism", "glassmorphism", "neumorphism", "brutalism", "dark mode", "flat", "aurora", "prompt", "css", "implementation", "variable", "checklist", "tailwind"],
        "ux": ["ux", "usability", "accessibility", "wcag", "touch", "scroll", "animation", "keyboard", "navigation", "mobile"],
        "typography": ["font pairing", "typography pairing", "heading font", "body font"],
        "google-fonts": ["google font", "font family", "font weight", "font style", "variable font", "noto", "font for", "find font", "font subset", "font language", "monospace font", "serif font", "sans serif font", "display font", "handwriting font", "font", "typography", "serif", "sans"],
        "icons": ["icon", "icons", "lucide", "heroicons", "symbol", "glyph", "pictogram", "svg icon"],
        "gsap": ["gsap", "quickto", "scrolltrigger", "stagger", "magnetic cursor", "parallax", "page transition", "scroll reveal", "scroll-triggered", "scrollytelling", "flip plugin", "splittext", "shimmer", "skeleton loader"],
        "react": ["react", "next.js", "nextjs", "suspense", "memo", "usecallback", "useeffect", "rerender", "bundle", "waterfall", "barrel", "dynamic import", "rsc", "server component"],
        "web": ["aria", "focus", "outline", "semantic", "virtualize", "autocomplete", "form", "input type", "preconnect"]
    }
    return _DOMAIN_KEYWORDS


# Domains checked in this fixed order when scores tie, so results are
# deterministic instead of depending on dict/hash ordering.
_DOMAIN_TIEBREAK_ORDER = [
    "ux", "product", "style", "color", "typography", "google-fonts",
    "chart", "landing", "icons", "gsap", "react", "web",
]


def detect_domain(query, return_scores=False):
    """Auto-detect the most relevant domain from query.

    Matches are weighted by keyword length (multi-word/longer phrases are
    more specific and score higher than short generic words). Ties are
    broken by a fixed domain priority order, not dict/insertion order.
    """
    query_lower = query.lower()
    domain_keywords = _domain_keywords()

    scores = {}
    for domain, keywords in domain_keywords.items():
        total = 0.0
        for kw in keywords:
            if re.search(r'\b' + re.escape(kw) + r'\b', query_lower):
                # weight = 1 point per word in the keyword phrase
                total += max(1, len(kw.split()))
        scores[domain] = total

    ranked = sorted(
        scores.items(),
        key=lambda item: (item[1], -_DOMAIN_TIEBREAK_ORDER.index(item[0])
                           if item[0] in _DOMAIN_TIEBREAK_ORDER else -999),
        reverse=True,
    )
    best_domain, best_score = ranked[0]
    result = best_domain if best_score > 0 else "style"

    if return_scores:
        runner_up = ranked[1][0] if len(ranked) > 1 and ranked[1][1] > 0 else None
        return result, runner_up
    return result


def search(query, domain=None, max_results=MAX_RESULTS):
    """Main search function with auto-domain detection"""
    auto_detected = domain is None
    runner_up = None
    if domain is None:
        domain, runner_up = detect_domain(query, return_scores=True)

    config = CSV_CONFIG.get(domain, CSV_CONFIG["style"])
    filepath = DATA_DIR / config["file"]

    if not filepath.exists():
        return {"error": f"File not found: {filepath}", "domain": domain}

    results, bm25 = _search_csv(filepath, config["search_cols"], config["output_cols"], query, max_results)

    out = {
        "domain": domain,
        "query": query,
        "file": config["file"],
        "count": len(results),
        "results": results,
    }
    if auto_detected:
        out["auto_detected"] = True
        if runner_up:
            out["runner_up_domain"] = runner_up
    if not results:
        out["suggestions"] = _suggest_terms(bm25, query)
    return out


def search_stack(query, stack, max_results=MAX_RESULTS):
    """Search stack-specific guidelines"""
    if stack not in STACK_CONFIG:
        return {"error": f"Unknown stack: {stack}. Available: {', '.join(AVAILABLE_STACKS)}"}

    filepath = DATA_DIR / STACK_CONFIG[stack]["file"]

    if not filepath.exists():
        return {"error": f"Stack file not found: {filepath}", "stack": stack}

    results, bm25 = _search_csv(filepath, _STACK_COLS["search_cols"], _STACK_COLS["output_cols"], query, max_results)

    out = {
        "domain": "stack",
        "stack": stack,
        "query": query,
        "file": STACK_CONFIG[stack]["file"],
        "count": len(results),
        "results": results,
    }
    if not results:
        out["suggestions"] = _suggest_terms(bm25, query)
    return out
