#!/usr/bin/env bash
# Sends a daily briefing to Jeff via Telegram using HTML parse mode.
# Handles Telegram's 4096-character message limit by splitting long briefings.
# Usage: TELEGRAM_BOT_TOKEN=<token> JEFF_TELEGRAM_CHAT_ID=<id> ./send-briefing-telegram.sh
# Briefing text is read from stdin or from $BRIEFING_TEXT env var.
set -euo pipefail

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-${BOT_TOKEN:-}}"
CHAT_ID="${JEFF_TELEGRAM_CHAT_ID:-${CHAT_ID:-}}"

if [[ -z "$BOT_TOKEN" || -z "$CHAT_ID" ]]; then
  echo "ERROR: TELEGRAM_BOT_TOKEN and JEFF_TELEGRAM_CHAT_ID are required." >&2
  exit 1
fi

BRIEFING="${BRIEFING_TEXT:-}"
if [[ -z "$BRIEFING" ]]; then
  BRIEFING=$(cat)
fi

if [[ -z "$BRIEFING" ]]; then
  echo "ERROR: No briefing text provided (stdin or BRIEFING_TEXT env var)." >&2
  exit 1
fi

escape_html() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'
}

linkify_issue_ids() {
  local s="$1"
  printf '%s' "$s" | sed -E 's/([A-Z]{2,})-([0-9]+)/<a href="https:\/\/paperclip.avva.aero\/\1\/issues\/\1-\2">\1-\2<\/a>/g'
}

BRIEFING_ESCAPED=$(escape_html "$BRIEFING")
BRIEFING_HTML=$(linkify_issue_ids "$BRIEFING_ESCAPED")

TIMESTAMP=$(TZ='America/Chicago' date '+%B %-d, %Y, %-I:%M %p Central')

# Telegram's sendMessage limit is 4096 characters.
# Split long briefings into multiple messages to avoid silent truncation.
MAX_CHARS=4000
NL=$'\n'
HEADER="📋 <b>Daily Executive Briefing</b>"
CONTINUE_HEADER="📋 <b>Daily Executive Briefing (continued)</b>"
INTERMEDIATE_FOOTER="${NL}${NL}<i>Generated: ${TIMESTAMP}</i>${NL}${NL}To be continued..."
FINAL_FOOTER="${NL}${NL}<i>Generated: ${TIMESTAMP}</i>${NL}${NL}End of briefing."

send_message() {
  local text="$1"
  local body
  body=$(cat <<EOFBODY
{
  "chat_id": $CHAT_ID,
  "text": "$text",
  "parse_mode": "HTML",
  "disable_web_page_preview": true
}
EOFBODY
  )
  local url="https://api.telegram.org/bot${BOT_TOKEN}/sendMessage"
  local response
  response=$(curl -s -w "\n%{http_code}" --max-time 30 -X POST "$url" \
    -H "Content-Type: application/json" \
    -d "$body" 2>&1)
  local http_code
  http_code=$(echo "$response" | tail -1)
  local body_resp
  body_resp=$(echo "$response" | sed '$d')
  if [[ "$http_code" != "200" ]]; then
    echo "ERROR: Telegram API returned HTTP $http_code" >&2
    echo "$body_resp" >&2
    return 1
  fi
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  printf '%s' "$s"
}

validate_briefing() {
  local content="$1"
  local errors=0

  local section_nums
  section_nums=$(echo "$content" | grep -oE '^[0-9]+\.' | grep -oE '[0-9]+')

  if [[ -z "$section_nums" ]]; then
    echo "ERROR: No numbered sections found in briefing" >&2
    errors=1
  else
    local expected=1
    for num in $section_nums; do
      if [[ "$num" -ne "$expected" ]]; then
        echo "ERROR: Section numbering unexpected. Expected $expected, found $num" >&2
        errors=1
      fi
      expected=$((expected + 1))
    done
  fi

  if echo "$content" | grep -qE '^[0-9]+\.\s*$'; then
    echo "ERROR: Empty section header found (section number with no title)" >&2
    errors=1
  fi

  local last_line
  last_line=$(echo "$content" | tail -1)
  if [[ -n "$last_line" ]] && echo "$last_line" | grep -qE '^[0-9]+\.'; then
    echo "ERROR: Briefing ends immediately after numbered heading: $last_line" >&2
    errors=1
  fi

  return $errors
}

send_briefing_chunk() {
  local chunk="$1"
  local header="$2"
  local footer="$3"
  local full_text="${header}${NL}${NL}${chunk}${footer}"
  local escaped
  escaped=$(json_escape "$full_text")
  send_message "$escaped"
}

chunk_and_send() {
  local content="$1"
  local content_len=${#content}
  local header="$HEADER"
  local footer="$FINAL_FOOTER"
  local header_len=${#header}
  local footer_len=${#footer}
  local had_error=0

  local available=$(( MAX_CHARS - header_len - footer_len ))

  if (( content_len <= available )); then
    send_briefing_chunk "$content" "$header" "$footer"
    return $?
  fi

  local pos=0
  local part=0
  while (( pos < content_len )); do
    if (( part == 0 )); then
      header="$HEADER"
    else
      header="$CONTINUE_HEADER"
    fi

    local is_last=0
    local end=$(( pos + MAX_CHARS - ${#header} - ${#INTERMEDIATE_FOOTER} ))
    if (( end >= content_len )); then
      end=$content_len
      is_last=1
    else
      local search_start=$(( end - 200 ))
      if (( search_start < pos )); then
        search_start=$pos
      fi
      local segment="${content:search_start:$(( end - search_start ))}"
      local last_para_break=0
      local search_pos=$(( ${#segment} - 1 ))
      while (( search_pos >= 2 )); do
        if [[ "${segment:search_pos-1:2}" == $'\n\n' ]]; then
          last_para_break=$(( search_pos + 1 ))
          break
        fi
        search_pos=$(( search_pos - 1 ))
      done
      if (( last_para_break > 0 )); then
        end=$(( search_start + last_para_break ))
      else
        local last_line_break=0
        search_pos=$(( ${#segment} - 1 ))
        while (( search_pos >= 1 )); do
          if [[ "${segment:search_pos:1}" == $'\n' ]]; then
            last_line_break=$(( search_pos + 1 ))
            break
          fi
          search_pos=$(( search_pos - 1 ))
        done
        if (( last_line_break > 0 )); then
          end=$(( search_start + last_line_break ))
        fi
      fi
    fi

    if (( is_last )); then
      footer="$FINAL_FOOTER"
    else
      footer="$INTERMEDIATE_FOOTER"
    fi

    local chunk="${content:pos:$(( end - pos ))}"
    if ! send_briefing_chunk "$chunk" "$header" "$footer"; then
      had_error=1
    fi
    pos=$end
    part=$(( part + 1 ))
  done
  return $had_error
}

if ! validate_briefing "$BRIEFING"; then
  FALLBACK_TEXT="Briefing incomplete — delivery failed before completion."
  FALLBACK_ESCAPED=$(json_escape "$FALLBACK_TEXT")
  send_message "$FALLBACK_ESCAPED" || true

  if [[ -n "${PAPERCLIP_TASK_ID:-}" && -n "${PAPERCLIP_API_URL:-}" && -n "${PAPERCLIP_API_KEY:-}" ]]; then
    echo "$BRIEFING" | scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" 2>/dev/null || true
  fi

  exit 1
fi

if ! chunk_and_send "$BRIEFING_HTML"; then
  FALLBACK_TEXT="Briefing incomplete — delivery failed before completion."
  FALLBACK_ESCAPED=$(json_escape "$FALLBACK_TEXT")
  send_message "$FALLBACK_ESCAPED" || true

  if [[ -n "${PAPERCLIP_TASK_ID:-}" && -n "${PAPERCLIP_API_URL:-}" && -n "${PAPERCLIP_API_KEY:-}" ]]; then
    echo "$BRIEFING" | scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" 2>/dev/null || true
  fi

  exit 1
fi
echo "Briefing delivered to Telegram (chat_id=$CHAT_ID)."
