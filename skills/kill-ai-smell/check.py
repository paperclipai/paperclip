#!/usr/bin/env python3
"""Mechanical sweep for AI writing tells.

Usage: python3 check.py FILE [FILE...]

Checks Markdown or plain-text prose against the kill-ai-smell rules and
prints findings with line numbers. Code blocks, inline code, URLs, and
YAML frontmatter are ignored. Two severities:

  VIOLATION  banned pattern or rate over budget; restructure until clean
  REVIEW     needs judgment (for example, a negation that may be content)

Exit code is 1 when any VIOLATION is found, else 0. Rate thresholds come
from the stylometric study in https://github.com/osolmaz/ai-smell.
"""
import re
import sys
from pathlib import Path

HEDGING = [
    "it's worth noting", "it is worth noting", "it's important to note",
    "it is important to note", "it's important to remember",
    "keep in mind that", "needless to say",
]
TRANSITIONS = ["moreover", "furthermore", "in conclusion", "in summary"]
INFLATED = [
    "delve", "delves", "delving", "tapestry", "testament to", "landscape",
    "crucial", "leverage", "leverages", "leveraged", "leveraging",
    "robust", "seamless", "seamlessly", "supercharge", "game-changer",
]
CONTRAST_BANNED = [
    (r"\bnot\s+(?:just|only|merely)\b", '"not just X" escalation'),
    (r"\bit\s+is\s+not\s+[^.;]{1,40}[,.;]\s*it\s+is\b", '"it is not X, it is Y"'),
    (r"\bisn't\s+[^.;]{1,40}[,.;]\s*it's\b", '"isn\'t X, it\'s Y"'),
]
CONTRAST_REVIEW = [
    (r",\s*not\s+[a-z]", '"X, not Y" contrast (allowed only as real content)'),
    (r"\bnot\s+[^.;:]{1,30},\s*but\b", '"not X, but Y"'),
    (r"\brather than\b", '"rather than" contrast frame'),
]


def strip_prose(raw):
    """Return (lines, in_prose_mask): code fences and frontmatter blanked."""
    lines = raw.splitlines()
    out = []
    in_code = False
    in_front = False
    for i, line in enumerate(lines):
        s = line.strip()
        if i == 0 and s == "---":
            in_front = True
            out.append("")
            continue
        if in_front:
            out.append("")
            if s == "---":
                in_front = False
            continue
        if s.startswith("```"):
            in_code = not in_code
            out.append("")
            continue
        if in_code:
            out.append("")
            continue
        line = re.sub(r"<!--.*?-->", "", line)
        line = re.sub(r"`[^`]+`", "CODE", line)
        line = re.sub(r"\]\([^)]+\)", "]", line)   # markdown link targets
        line = re.sub(r"https?://\S+", "URL", line)
        out.append(line)
    return out


def sentences(text):
    for abbr in ("e.g.", "i.e.", "vs.", "etc."):
        text = text.replace(abbr, abbr.replace(".", "\u0000"))
    text = re.sub(r"(\d)\.(\d)", "\\1\u0000\\2", text)
    parts = re.split(r"(?<=[.!?])\s+", text)
    return [p.replace("\u0000", ".") for p in parts if p.strip()]


def check(path):
    lines = strip_prose(Path(path).read_text())
    findings = []  # (severity, line_no or None, message)

    headings, bullets, body = [], [], []
    for n, line in enumerate(lines, 1):
        if re.match(r"\s*#{1,6}\s", line):
            headings.append((n, re.sub(r"^\s*#{1,6}\s+", "", line).strip()))
        elif re.match(r"\s*([-*+]|\d+\.)\s", line):
            bullets.append((n, line))
            body.append((n, re.sub(r"^\s*([-*+]|\d+\.)\s+", "", line)))
        elif line.strip():
            body.append((n, line))

    text = " ".join(l for _, l in body)
    words = re.findall(r"[A-Za-z0-9'’-]+", text)
    n_words = max(len(words), 1)
    per_1k = lambda count: round(count * 1000.0 / n_words, 1)

    # --- punctuation ---
    def dashes(line):
        if re.match(r"^\s*\|?[\s|:-]+\|?\s*$", line):   # table separator / hrule
            return []
        return re.findall(r"—|(?<!-)--(?!-)| - ", line)

    dash_lines = [n for n, l in body for _ in dashes(l)]
    budget = max(1, n_words // 1000)
    if len(dash_lines) > budget:
        findings.append(("VIOLATION", None,
                         f"{len(dash_lines)} em dashes for {n_words} words "
                         f"(budget {budget}); lines {sorted(set(dash_lines))}"))

    for n, l in body:
        if l.count(";") >= 2:
            findings.append(("VIOLATION", n, "semicolon chain"))
    semis = sum(l.count(";") for _, l in body)
    if per_1k(semis) > 3:
        findings.append(("REVIEW", None,
                         f"semicolons at {per_1k(semis)}/1k words (humans stay under 3)"))

    # Mid-sentence prose colons. A colon that ends the line introduces a
    # list or block quote and is fine; a colon with prose flowing on is
    # usually the pivot crutch. Each one gets a REVIEW, and a streak of
    # three consecutive paragraphs hinging on one is a VIOLATION.
    pivot_lines = []
    for n, l in body:
        for m in re.finditer(r"[a-z\"\u201d)](?<!\d):(?!\d)\s+(\S[^.!?]{0,80})", l):
            findings.append(("REVIEW", n,
                             f'colon pivot: "...: {m.group(1).strip()[:60]}"'))
            pivot_lines.append(n)
    para_lines = [n for n, _ in body]
    streak, prev = [], None
    for n in para_lines:
        if n in pivot_lines:
            streak.append(n)
            if len(streak) >= 3:
                findings.append(("VIOLATION", n,
                                 f"3+ consecutive paragraphs pivot on a colon "
                                 f"(lines {streak[-3:]})"))
                streak = []
        else:
            streak = []

    # --- sentence patterns ---
    for n, l in body:
        low = l.lower()
        for pat, name in CONTRAST_BANNED:
            if re.search(pat, low):
                findings.append(("VIOLATION", n, name))
        for pat, name in CONTRAST_REVIEW:
            if re.search(pat, low):
                findings.append(("REVIEW", n, name))
        for phrase in HEDGING:
            if phrase in low:
                findings.append(("VIOLATION", n, f'hedging: "{phrase}"'))
        for word in TRANSITIONS:
            if re.search(r"\b" + word + r"\b", low):
                findings.append(("VIOLATION", n, f'overwrought transition: "{word}"'))
        for word in INFLATED:
            if re.search(r"\b" + re.escape(word) + r"\b", low):
                findings.append(("REVIEW", n, f'inflated vocabulary: "{word}"'))
        if re.search(r"\bno\s+[\w-]+(?:\s+[\w-]+)?,\s*no\s+[\w-]+", low):
            findings.append(("VIOLATION", n, "anaphora chain (no X, no Y, ...)"))

    triads = len(re.findall(r"\b[\w'’-]+,\s+[\w'’-]+,\s+and\s+[\w'’-]+\b", text))
    if per_1k(triads) > 3:
        findings.append(("VIOLATION", None,
                         f"exactly-three lists at {per_1k(triads)}/1k words "
                         "(detector threshold is 3)"))
    elif triads >= 2:
        findings.append(("REVIEW", None,
                         f"{triads} exactly-three lists; fine if they enumerate "
                         "real items, a tell if rhetorical"))

    sents = sentences(text)
    frags = [s for s in sents if len(re.findall(r"[\w'’-]+", s)) <= 4]
    if sents and len(frags) / len(sents) > 0.15:
        findings.append(("REVIEW", None,
                         f"{len(frags)} of {len(sents)} sentences are fragments "
                         f"of 4 words or fewer ({100 * len(frags) // len(sents)}%)"))

    # Sentence flow: the longest run of words in each sentence with no
    # punctuation break. Human prose keeps producing sentences with one
    # run of 10+ words; AI copy breaks nearly every sentence first. In
    # the study corpus the AI pages average 4.9-8.8 words per longest
    # run and every human text 10.0 or more.
    runs = []
    for s in sents:
        pieces = re.split(r"[,;:—()]|\s--?\s", s)
        lens = [len(re.findall(r"[\w'’-]+", p)) for p in pieces]
        lens = [l for l in lens if l]
        if lens:
            runs.append(max(lens))
    if len(runs) >= 15:
        mean_run = sum(runs) / len(runs)
        if mean_run < 10:
            findings.append(("REVIEW", None,
                             f"sentence flow: mean longest unbroken run is "
                             f"{mean_run:.1f} words (AI pages 4.9-8.8, human "
                             f"texts 10.0+); let main clauses run without a "
                             f"punctuation break"))

    # Synonym rotation, measured as MTLD lexical diversity (bidirectional,
    # threshold 0.72). Every AI page in the study scores above 111 while
    # seven of eight human texts stay under 106.
    def mtld_pass(tokens, threshold=0.72):
        factors, types, count = 0.0, set(), 0
        for t in tokens:
            count += 1
            types.add(t)
            if len(types) / count <= threshold:
                factors += 1
                types, count = set(), 0
        if count:
            factors += (1 - len(types) / count) / (1 - threshold)
        return len(tokens) / factors if factors else 0.0

    tokens = [w.lower() for w in re.findall(r"[A-Za-z'’-]+", text)]
    if len(tokens) >= 300:
        mtld = (mtld_pass(tokens) + mtld_pass(tokens[::-1])) / 2
        if mtld > 110:
            findings.append(("REVIEW", None,
                             f"MTLD lexical diversity is {mtld:.0f} (AI pages "
                             f"score 111+, humans mostly under 106); reuse the "
                             f"established word instead of rotating synonyms"))

    # --- bullets ---
    labeled = []
    for n, b in bullets:
        m = re.match(r"\s*[-*+]\s+(?:\*\*)?([^—:.]{1,60}?)(?:\*\*)?\s*(?:[—:.])\s+\S", b)
        if m and len(m.group(1).split()) <= 5:
            labeled.append(n)
    if bullets and len(labeled) / len(bullets) > 0.3:
        findings.append(("VIOLATION", None,
                         f"labeled bullets are {100 * len(labeled) // len(bullets)}% "
                         f"of {len(bullets)} bullets (threshold 30%); "
                         f"lines {labeled}"))

    # --- headings ---
    for n, h in headings:
        h_words = h.split()
        if re.match(r"^\d+[.)]\s", h):
            findings.append(("VIOLATION", n, f'manually numbered heading: "{h}"'))
        if h.count(",") == 1 and len(h_words) <= 6 and not h.endswith("?"):
            findings.append(("REVIEW", n, f'possible comma-couplet heading: "{h}"'))
        caps = [w for w in h_words[1:] if re.match(r"^[A-Z][a-z]", w)]
        if len(h_words) >= 3 and len(caps) >= len(h_words) / 2:
            findings.append(("REVIEW", n, f'Title Case heading: "{h}"'))
        if re.match(r"^(why|what|how|where)\b", h, re.I) and not h.endswith("?"):
            findings.append(("REVIEW", n, f'rhetorical-frame heading: "{h}"'))

    return findings, n_words


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip())
        return 2
    exit_code = 0
    for path in argv[1:]:
        findings, n_words = check(path)
        violations = [f for f in findings if f[0] == "VIOLATION"]
        if violations:
            exit_code = 1
        print(f"== {path} ({n_words} words): "
              f"{len(violations)} violations, "
              f"{len(findings) - len(violations)} to review")
        for sev, line, msg in sorted(findings, key=lambda f: (f[0] != "VIOLATION", f[1] or 0)):
            loc = f"line {line}" if line else "document"
            print(f"  {sev:9s} {loc}: {msg}")
    return exit_code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
