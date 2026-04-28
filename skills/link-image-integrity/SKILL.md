---
name: link-image-integrity
description: Crawl a Bobby Tours site's sitemap and verify every internal link and image returns HTTP 200. Use daily to catch rot — broken internal links, 404 images, stale CDN URLs. Lightweight curl-based, runs on Paperclip VPS.
---

# Link & Image Integrity

## When to use

- Daily as part of the extended deploy-health routine (already scheduled 03:30 EAT)
- After major content changes or site structure refactors
- Before writing new pages that might depend on existing internal links

## Scope per run

Per site:
1. Fetch `https://<domain>/sitemap.xml`
2. Extract all URLs
3. For each URL: `curl -sI` → record status code
4. For each URL returning 200: fetch body, extract all `<a href>` + `<img src>`
5. For each link/image URL: `curl -sI` → record status
6. Summarize: broken internal URLs, broken outgoing links, broken images

## Procedure

1. **Pull sitemap:**
   ```bash
   DOMAIN=<domain>  # e.g. bobbysafaris.com
   curl -sSL "https://$DOMAIN/sitemap.xml" > /tmp/sitemap-$DOMAIN.xml
   # Some sites have sitemap-0.xml, sitemap-1.xml etc. Expand.
   URLS=$(grep -oP '(?<=<loc>)https?://[^<]+' /tmp/sitemap-$DOMAIN.xml | sort -u)
   echo "$URLS" | wc -l   # count pages
   ```

2. **Fast check all URLs in sitemap** (should all be 200):
   ```bash
   for url in $URLS; do
     CODE=$(curl -sSL -o /dev/null -w "%{http_code}" --max-time 10 "$url")
     [ "$CODE" != "200" ] && echo "BROKEN: $url → $CODE"
   done
   ```
   Target: **zero non-200**. Any non-200 is a P1 bug.

3. **Deep check of homepage + top 10 pages** (extract + check all links & images in their HTML):
   ```bash
   for url in "https://$DOMAIN/" <first 10 URLs from sitemap>; do
     BODY=$(curl -sSL --max-time 20 "$url")
     
     # internal links (same domain)
     LINKS=$(echo "$BODY" | grep -oP 'href="[^"]+"' | grep -oP '(?<=")[^"]+' | grep -E "^/|^https?://$DOMAIN" | sort -u)
     
     # images (img src + srcset first URL)
     IMGS=$(echo "$BODY" | grep -oP 'src="[^"]+\.(webp|avif|jpg|jpeg|png|svg)' | grep -oP '(?<=")[^"]+' | sort -u)
     
     # Resolve relative → absolute
     # Check each returns 200
   done
   ```

4. **Quota targets** (flag if exceeded):
   - 0 broken internal links (critical)
   - ≤2 broken outgoing links (low priority; external sites rot, not our fault)
   - 0 broken images on top 10 pages (critical — dead images = visible brand damage)
   - ≤5% redirects inside internal links (301/302 chains slow pages)

5. **Edge cases:**
   - Some "links" are Javascript handlers or mailto: or tel: — exclude these from URL checks
   - WhatsApp deep links (`wa.me/...`) — include in outgoing checks (200 is normal)
   - Fragment-only links (#section) — exclude (always valid on own page)
   - Next.js `_next/` URLs — skip (build-generated, Contabo-owned)

6. **Report format:**

   ```
   ## Link & image integrity — <domain>
   Sitemap URLs: 529
   Checked: 529 sitemap URLs + 10 deep-scanned pages (homepage + top 10)
   
   ### Broken sitemap URLs (CRITICAL)
   - /itineraries/old-safari-package → 404
   - /it/pacchetti-speciali → 410
   
   ### Broken internal links (CRITICAL)
   From /blog/wildebeest-migration:
   - /itineraries/serengeti-migration-7d → 404 (link text: "See migration itinerary")
   
   ### Broken images (CRITICAL)
   From /:
   - /images/hero-old.webp → 404 (alt: "Tanzania safari")
   
   ### Broken outgoing links (LOW priority)
   From /about: https://tripadvisor.com/... → 404 (their URL changed)
   
   ### Redirect chains (MEDIUM)
   None.
   
   Summary: 2 critical broken URLs, 1 broken image, 1 broken internal link.
   Alert level: P1.
   ```

7. **On any CRITICAL finding, send Telegram alert:**
   ```bash
   curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN_REAL/sendMessage" \
     -d chat_id="$TELEGRAM_DON_CHAT_ID" \
     -d text="🚩 Link/image integrity: <domain> has 3 broken URLs + 1 broken image. See ticket."
   ```

## Pitfalls

- curl timeout: set `--max-time 10` on every check; some CDNs time out
- Large sites (500+ URLs): full crawl = 5-15 min. Reasonable budget.
- Rate-limiting: Cloudflare might throttle if you hit 100 URLs in 10s. Add `--limit-rate 5M` or pause 0.1s between requests: `sleep 0.1`
- URLs with redirects: use `-L` to follow + check final status, OR report the redirect chain itself
- Dynamic/JS-loaded content: curl doesn't render JS. Some "broken" links might actually work in the browser. Acceptable false positive rate ~1%.

## Budget

$0.20–$0.50 per site per run (compute is free, token spend is in interpreting + reporting results). 5 sites sequentially = $1–2.50 daily.
