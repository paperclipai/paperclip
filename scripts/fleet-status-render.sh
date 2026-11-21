#!/usr/bin/env bash
#
# fleet-status rendering — the text panel and the JSON document.
#
# This file is sourced by scripts/fleet-status.sh. It holds the output layer
# only: the column layout, the width calculation, the JSON escaping and the
# footers. The decision rules stay in scripts/fleet-status.sh, so the text
# panel and the JSON document cannot disagree.
#
# The caller provides the data through the globals ROWS, SCOPE_NAMES,
# SCOPE_NAME_LIST, SCOPE_MULTI and the summary counters.
#
# It needs bash and nothing else.
# ---------------------------------------------------------------- rendering

# Resolves a UTF-8 locale for character counting. Without one, bash reports byte
# lengths and CJK text is padded to three columns per character.
resolve_utf8_locale() {
  local name
  for name in C.UTF-8 en_US.UTF-8; do
    if [ "$(LC_ALL=$name locale charmap 2>/dev/null)" = "UTF-8" ]; then
      printf '%s' "$name"
      return 0
    fi
  done
  return 1
}

# Sets W to the display width of $1 in terminal columns, computed from bytes
# rather than characters so the table lines up the same way under LC_ALL=C
# (cron, systemd, CI) as it does in an interactive shell. Three-byte characters
# are CJK and occupy two columns; a two-byte character is counted one column
# short, which is rare in agent names and only ever under-pads.
#
# The length calls are builtins scoped by a local LC_ALL, so the per-cell cost
# is arithmetic rather than a fork. The tr/wc fallback runs only on hosts with
# no UTF-8 locale at all.
disp_width() {
  local s=$1 chars bytes
  case "$s" in
    *[!-~]*) ;;
    *) W=${#s}; return ;;
  esac
  if [ -n "$UTF8_LOCALE" ]; then
    local LC_ALL=$UTF8_LOCALE
    chars=${#s}
    local LC_ALL=C
    bytes=${#s}
    W=$(( chars + (bytes - chars) / 2 ))
    return
  fi
  chars=$(printf '%s' "$s" | tr -d '\000-\177' | wc -c | tr -d '[:space:]')
  bytes=$(printf '%s' "$s" | wc -c | tr -d '[:space:]')
  case "$chars$bytes" in
    ''|*[!0-9]*) W=${#s}; return ;;
  esac
  W=$(( (bytes - chars) + (chars / 3) * 2 ))
}

# Resolved once at load time so sourced callers get the same behaviour as an
# executed run.
UTF8_LOCALE=$(resolve_utf8_locale 2>/dev/null) || UTF8_LOCALE=""

# Writes one line of output. A consumer that stops reading (`| head`) is normal
# usage and ends the panel quietly; a failed write to a file or device is a real
# failure and must not be reported as a successful run.
emit() {
  # stderr is silenced for the write itself: bash prints "write error: Broken
  # pipe" for every remaining cell otherwise. Formats here are literals, so the
  # only thing being hidden is that message.
  printf "$@" 2>/dev/null && return 0
  if [ -f /dev/stdout ]; then
    printf '%s: cannot write output\n' "$PROG" >&2
    exit 2
  fi
  # A closed pipe (SIGPIPE). Exit 141 (128 + 13) so a watched loop can detect
  # it and stop instead of keeping the database busy after the reader leaves.
  exit 141
}

# Sets PADDED to $1 right-padded to $2 display columns.
pad() {
  local s=$1 width=$2 fill
  disp_width "$s"
  fill=$(( width - W ))
  if [ "$fill" -lt 0 ]; then fill=0; fi
  printf -v PADDED '%s%*s' "$s" "$fill" ''
}

# Sets JSON to $1 as a quoted JSON string.
json_string() {
  local s=$1 out="" rest ch
  local LC_ALL=C
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\b'/\\b}
  s=${s//$'\f'/\\f}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}

  # A control character that the replacements above do not cover would make the
  # document invalid, so it becomes a \u00XX escape. The common ones are already
  # gone, so this loop only runs for the rare string.
  case "$s" in
    *[[:cntrl:]]*)
      rest=$s
      while [ -n "$rest" ]; do
        ch=${rest:0:1}
        rest=${rest:1}
        case "$ch" in
          [[:cntrl:]]) printf -v ch '\\u%04x' "'$ch" ;;
        esac
        out=$out$ch
      done
      s=$out
      ;;
  esac
  printf -v JSON '"%s"' "$s"
}

json_optional_string() {
  if [ -z "$1" ]; then JSON="null"; else json_string "$1"; fi
}

json_optional_number() {
  if [ -z "$1" ] || [ "$1" -lt 0 ] 2>/dev/null; then
    JSON="null"
  else
    JSON=$1
  fi
}

json_bool() {
  if [ "$1" -eq 1 ]; then JSON="true"; else JSON="false"; fi
}

# The table shows the derived state, not agents.status: a database row can still
# read "idle" while a run is already executing, and the panel's job is to say
# what is happening, not what was last written to the row.
state_label() {
  case "$1" in
    busy) STATE_LABEL='running' ;;
    queued) STATE_LABEL='queued' ;;
    idle_with_work) STATE_LABEL='cards idle' ;;
    waiting) STATE_LABEL='waiting' ;;
    free) STATE_LABEL='available' ;;
    paused) STATE_LABEL='paused' ;;
    error) STATE_LABEL='error' ;;
    pending_approval) STATE_LABEL='approval' ;;
    *) STATE_LABEL=$1 ;;
  esac
}

# Sets JSON to the attention codes as a JSON array.
json_attention_array() {
  local code sep="" out="["
  for code in $ROW_ATTENTION; do
    json_string "$code"
    out="$out$sep$JSON"
    sep=","
  done
  JSON="$out]"
}

# Sets JSON to the resolved company names as a JSON array.
scope_companies_json() {
  local name first=1 out=""
  for name in ${SCOPE_NAME_LIST[@]+"${SCOPE_NAME_LIST[@]}"}; do
    if [ "$first" -eq 0 ]; then out="$out, "; fi
    first=0
    json_string "$name"
    out="$out$JSON"
  done
  JSON="[$out]"
}

render_header_text() {
  emit '══ FLEET STATUS %s ══\n' "$GENERATED_AT"
  emit 'scope %s · thresholds running>%sm/silent>%sm · open>%sm · review>%sm · wake window %sh/queued>%sm\n' \
    "$SCOPE_NAMES" "$RUNNING_SLOW" "$RUN_SILENT" "$TODO_IDLE" "$REVIEW_WAIT" "$WAKE_WINDOW_H" "$WAKE_STALE"
  emit '\n'
  local line="" rule=""
  if [ "$SCOPE_MULTI" -eq 1 ]; then
    pad 'Company' 14; line="$PADDED "
    rule='-------------- '
  fi
  pad 'AGENT' 14; line="$line$PADDED "; rule="$rule-------------- "
  pad 'State' 12; line="$line$PADDED "; rule="$rule------------ "
  pad 'Card' 10; line="$line$PADDED "; rule="$rule---------- "
  pad 'Age' 8; line="$line$PADDED "; rule="$rule-------- "
  pad 'Open/Rev/Pau' 12; line="$line$PADDED"; rule="$rule------------"
  emit '%s\n' "$line"
  emit '%s\n' "$rule"
}

render_row_text() {
  local company=$1 name=$2 state=$3 run_card=$4 run_age=$5
  local active=$6 review=$7 parked=$8
  local shown_card="-" shown_age="-" line=""

  if [ -n "$run_card" ]; then shown_card=$run_card; fi
  if [ "$run_age" -ge 0 ]; then shown_age="${run_age}m"; fi

  if [ "$SCOPE_MULTI" -eq 1 ]; then
    pad "$company" 14; line="$PADDED "
  fi
  pad "$name" 14; line="$line$PADDED "
  state_label "$state"; pad "$STATE_LABEL" 12; line="$line$PADDED "
  pad "$shown_card" 10; line="$line$PADDED "
  pad "$shown_age" 8; line="$line$PADDED "
  pad "${active}/${review}/${parked}" 12; line="$line$PADDED "
  emit '%s%s\n' "$line" "${ROW_NOTE:-—}"
}

render_footer_text() {
  emit '\n── SUMMARY ──\n'
  emit '  agent %s: running %s · queued %s · cards idle %s · cards waiting %s · available %s · paused %s · error %s · approval %s\n' \
    "$N_TOTAL" "$N_BUSY" "$N_QUEUED" "$N_IDLE_WORK" "$N_WAITING" "$N_FREE" "$N_PAUSED" "$N_ERROR" "$N_PENDING_APPROVAL"
  emit '  review in_review %s · long runs %s · silent runs %s · paused with work %s · failed wakeups %s (%s agent(s)) · queued too long %s (%s agent(s) without a run)\n' \
    "$A_REVIEW" "$A_LONG_RUNNING" "$A_SILENT_RUN" "$A_PAUSED_WORK" \
    "$A_FAILED_WAKE_EVENTS" "$A_FAILED_WAKE" "$A_STALE_WAKE_EVENTS" "$A_STALE_WAKE"
  if [ "$EXCLUDED_TERMINATED" -gt 0 ]; then
    emit '  excluded %s terminated agent(s)\n' "$EXCLUDED_TERMINATED"
  fi

  emit '\n'
  if [ "$NEEDS_ATTENTION" -eq 1 ]; then
    emit '── ACTION NEEDED (%s agent(s) to check) ──\n' "$A_AGENTS"
    if [ "$A_IDLE_WORK" -gt 0 ]; then
      emit '  · %s agent(s) have open cards and no waiting path: check the tasks and the wakeups first, then decide whether to add a wakeup\n' "$A_IDLE_WORK"
    fi
    if [ "$A_LONG_RUNNING" -gt 0 ]; then
      emit '  · %s run(s) are long or queued too long: read the run log, the process and the artifacts first; this is not a stall verdict\n' "$A_LONG_RUNNING"
    fi
    if [ "$A_SILENT_RUN" -gt 0 ]; then
      emit '  · %s run(s) are silent: confirm that they still produce output; silence alone is not a stall\n' "$A_SILENT_RUN"
    fi
    if [ "$A_REVIEW" -gt 0 ]; then
      emit '  · %s in_review card(s) await a decision: the bottleneck is here, decide first, then hand out new work\n' "$A_REVIEW"
    fi
    if [ "$A_PAUSED_WORK" -gt 0 ]; then
      emit '  · %s paused agent(s) still hold unfinished cards: confirm that the pause is intended\n' "$A_PAUSED_WORK"
    fi
    if [ "$A_AGENT_ERROR" -gt 0 ]; then
      emit '  · %s agent(s) have status error: check the failure of the last run\n' "$A_AGENT_ERROR"
    fi
    if [ "$A_PENDING_APPROVAL" -gt 0 ]; then
      emit '  · %s agent(s) await approval\n' "$A_PENDING_APPROVAL"
    fi
    if [ "$A_FAILED_WAKE_EVENTS" -gt 0 ]; then
      emit '  · %s failed wakeup(s) in the last %sh: check each one to see whether a retry covered it\n' "$A_FAILED_WAKE_EVENTS" "$WAKE_WINDOW_H"
    fi
    if [ "$A_STALE_WAKE_EVENTS" -gt 0 ]; then
      emit '  · %s wakeup(s) queued longer than %sm: check the queue and the concurrency limit\n' "$A_STALE_WAKE_EVENTS" "$WAKE_STALE"
    fi
  else
    emit '  Nothing to do.\n'
  fi
}

render_text() {
  local line
  render_header_text
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    split_row "$line"
    classify_row "${F[@]}"
    tally_row "${F[15]}" "${F[18]}"
    render_row_text "${F[0]}" "${F[1]}" "$ROW_STATE" "${F[5]}" "${F[6]}" "${F[8]}" "${F[10]}" "${F[12]}"
  done <<< "$ROWS"
  render_footer_text
}

render_json() {
  local line sep=""
  local entries=()

  # Classify first: the summary block is printed above the per-agent entries,
  # so the counters must already be complete when it is written.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    split_row "$line"
    classify_row "${F[@]}"
    tally_row "${F[15]}" "${F[18]}"
    render_entry_json "${F[@]}"
    entries+=("$ENTRY")
  done <<< "$ROWS"

  emit '{\n'
  emit '  "schemaVersion": %s,\n' "$SCHEMA_VERSION"
  json_string "$GENERATED_AT_ISO"
  emit '  "generatedAt": %s,\n' "$JSON"
  json_optional_string "$COMPANY"
  local requested=$JSON
  scope_companies_json
  emit '  "scope": {"requested": %s, "companies": %s},\n' "$requested" "$JSON"
  emit '  "thresholds": {"runningSlowMinutes": %s, "runSilentMinutes": %s, "todoIdleMinutes": %s, "reviewWaitMinutes": %s, "wakeWindowHours": %s, "wakeStaleMinutes": %s},\n' \
    "$RUNNING_SLOW" "$RUN_SILENT" "$TODO_IDLE" "$REVIEW_WAIT" "$WAKE_WINDOW_H" "$WAKE_STALE"
  json_bool "$NEEDS_ATTENTION"
  emit '  "needsAttention": %s,\n' "$JSON"
  emit '  "summary": {\n'
  emit '    "agents": {"total": %s, "busy": %s, "queued": %s, "idleWithWork": %s, "waiting": %s, "free": %s, "paused": %s, "error": %s, "pendingApproval": %s, "excludedTerminated": %s},\n' \
    "$N_TOTAL" "$N_BUSY" "$N_QUEUED" "$N_IDLE_WORK" "$N_WAITING" "$N_FREE" "$N_PAUSED" "$N_ERROR" \
    "$N_PENDING_APPROVAL" "$EXCLUDED_TERMINATED"
  emit '    "attention": {"agents": %s, "longRunning": %s, "silentRun": %s, "idleWithWork": %s, "pausedWithWork": %s, "agentError": %s, "pendingApproval": %s, "reviewCards": %s, "failedWakeAgents": %s, "failedWakeEvents": %s, "staleWakeAgents": %s, "staleWakeEvents": %s}\n' \
    "$A_AGENTS" "$A_LONG_RUNNING" "$A_SILENT_RUN" "$A_IDLE_WORK" "$A_PAUSED_WORK" "$A_AGENT_ERROR" \
    "$A_PENDING_APPROVAL" "$A_REVIEW" "$A_FAILED_WAKE" "$A_FAILED_WAKE_EVENTS" "$A_STALE_WAKE" "$A_STALE_WAKE_EVENTS"
  emit '  },\n'
  emit '  "agents": [\n'
  # Indexed loop: bash 3.2 treats "${empty[@]}" as an unbound variable under
  # set -u, and this array is empty whenever the scope has no rows.
  local i=0
  while [ "$i" -lt "${#entries[@]}" ]; do
    emit '%s%s' "$sep" "${entries[$i]}"
    sep=$',\n'
    i=$((i + 1))
  done
  emit '\n  ]\n'
  emit '}\n'
}

# Sets ENTRY to one agent object. Every value is written through the JSON
# helpers, which set $JSON, so no value passes through a subshell.
render_entry_json() {
  local company=$1 name=$2 status=$3 pause_reason=$4
  local run_state=$5 run_card=$6 run_age=$7 run_silent=$8
  local active=$9 monitored=${10} review=${11} review_in_run=${12} parked=${13}
  local oldest_active=${14} oldest_review=${15}
  local failed=${16} failed_detail=${17}
  local pending=${18} stale_pending=${19} oldest_pending=${20} recoveries=${21}
  local out="    {" attention_flag=0

  json_string "$company"; out="$out\"company\": $JSON, "
  json_string "$name"; out="$out\"agent\": $JSON, "
  json_string "$status"; out="$out\"agentStatus\": $JSON, "
  json_optional_string "$pause_reason"; out="$out\"pauseReason\": $JSON, "
  json_string "$ROW_STATE"; out="$out\"state\": $JSON, "
  if [ -n "$ROW_ATTENTION" ]; then attention_flag=1; fi
  json_bool "$attention_flag"; out="$out\"needsAttention\": $JSON, "
  json_attention_array; out="$out\"attention\": $JSON, "
  json_optional_string "$ROW_NOTE"; out="$out\"note\": $JSON, "

  json_optional_string "$run_state"; out="$out\"run\": {\"state\": $JSON, "
  json_optional_string "$run_card"; out="$out\"card\": $JSON, "
  json_optional_number "$run_age"; out="$out\"ageMinutes\": $JSON, "
  json_optional_number "$run_silent"; out="$out\"silentMinutes\": $JSON}, "

  out="$out\"cards\": {\"active\": $active, \"activeMonitored\": $monitored, "
  out="$out\"review\": $review, \"reviewPending\": $ROW_REVIEW_PENDING, \"parked\": $parked, "
  json_optional_number "$oldest_active"; out="$out\"oldestActiveMinutes\": $JSON, "
  json_optional_number "$oldest_review"; out="$out\"oldestReviewMinutes\": $JSON}, "

  out="$out\"wakeups\": {\"failed\": $failed, "
  json_optional_string "$failed_detail"; out="$out\"failedDetail\": $JSON, "
  out="$out\"pending\": $pending, \"stalePending\": $stale_pending, "
  json_optional_number "$oldest_pending"; out="$out\"oldestPendingMinutes\": $JSON}, "

  ENTRY="$out\"recoveries\": $recoveries}"
}
