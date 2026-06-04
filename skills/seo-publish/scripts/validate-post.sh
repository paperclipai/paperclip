#!/bin/bash
# Validate a blog post before committing to ironnoodle-site
# Usage: ./validate-post.sh <slug>
# Example: ./validate-post.sh ai-receptionist-law-firm

SLUG="$1"
SITE_DIR="/Users/robertstanley/ironnoodle-site"
FILE="$SITE_DIR/blog/$SLUG.html"
PASS=0
FAIL=0

if [ -z "$SLUG" ]; then
  echo "Usage: ./validate-post.sh <slug>"
  exit 1
fi

if [ ! -f "$FILE" ]; then
  echo "FAIL: File not found: $FILE"
  exit 1
fi

check() {
  if eval "$1" > /dev/null 2>&1; then
    echo "PASS: $2"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $2"
    FAIL=$((FAIL + 1))
  fi
}

check_not() {
  if eval "$1" > /dev/null 2>&1; then
    echo "FAIL: $2"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: $2"
    PASS=$((PASS + 1))
  fi
}

echo "=== Validating blog/$SLUG.html ==="
echo ""

# Required elements
check "grep -q 'G-ZHCKX8GM25' '$FILE'" "GA4 tracking present"
check "grep -q 'tk_aebc37e3f03246be8657fd68115978cc' '$FILE'" "CogentCRM tracking present"
check "grep -q 'style.css?v=5' '$FILE'" "CSS version matches (v=5)"
check "grep -q 'application/ld+json' '$FILE'" "Structured data present"
check "grep -q 'rel=\"canonical\"' '$FILE'" "Canonical tag present"
check "grep -q 'lead-capture.js' '$FILE'" "Lead capture script present"
check "grep -q 'challenges.cloudflare.com/turnstile' '$FILE'" "Turnstile present"
check "grep -q 'og:type' '$FILE'" "Open Graph tags present"
check "grep -q 'twitter:card' '$FILE'" "Twitter Card present"
check "grep -q 'FAQPage' '$FILE'" "FAQPage structured data present"

# Forbidden patterns
check_not "grep -q 'href=\"[^\"]*ironnoodle\.com[^\"]*\.html' '$FILE'" "No .html in internal links"
check_not "grep -qi 'synthflow\|elevenlabs\|openrouter\|gohighlevel\|anthropic\|openai\|docker\|tailscale\|zapier\|skillboss' '$FILE'" "No vendor names leaked"
check_not "grep -q 'href=\"[^/]' '$FILE' | grep -v 'href=\"http\|href=\"mailto\|href=\"tel\|href=\"#'" "All paths absolute (start with /)"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ $FAIL -gt 0 ]; then
  echo "DO NOT COMMIT — fix failures first"
  exit 1
else
  echo "Ready to commit and push"
  exit 0
fi
