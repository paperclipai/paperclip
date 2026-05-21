#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 '<telegram request text>'" >&2
  exit 1
fi

REQUEST_TEXT="$*"
COMPANY_ID="cf91355d-699c-419d-91c9-27c0e783b8e0"
GOAL_ID="720afb2f-6ec2-4dd9-ba22-ed56cc20dcca"
API_URL_DEFAULT="http://127.0.0.1:3050"
BRIDGE_KEY_FILE="${HOME}/.openclaw/credentials/paperclip-bridge-api-key.json"
CLAIMED_KEY_FILE="${HOME}/.openclaw/workspace/paperclip-claimed-api-key.json"

KEY_FILE="$BRIDGE_KEY_FILE"
if [[ ! -f "$KEY_FILE" ]]; then
  KEY_FILE="$CLAIMED_KEY_FILE"
fi

if [[ ! -f "$KEY_FILE" ]]; then
  echo "missing Paperclip key file: $BRIDGE_KEY_FILE or $CLAIMED_KEY_FILE" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

PAPERCLIP_API_KEY="$(jq -r '.env.PAPERCLIP_API_KEY // empty' "$KEY_FILE")"
PAPERCLIP_API_URL="$(jq -r '.env.PAPERCLIP_API_URL // empty' "$KEY_FILE")"
if [[ -z "$PAPERCLIP_API_URL" ]]; then
  PAPERCLIP_API_URL="$API_URL_DEFAULT"
fi

if [[ "$PAPERCLIP_API_URL" == "http://127.0.0.1:3100" ]]; then
  PAPERCLIP_API_URL="http://127.0.0.1:3050"
fi

if [[ -z "$PAPERCLIP_API_KEY" ]]; then
  echo "missing PAPERCLIP_API_KEY in $KEY_FILE" >&2
  exit 1
fi

AGENTS_JSON="$(curl -sS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/agents")"

agent_id_by_url_key() {
  local key="$1"
  jq -r --arg key "$key" '.[] | select(.urlKey == $key) | .id' <<<"$AGENTS_JSON" | head -n 1
}

CHIEF_ID="$(agent_id_by_url_key chiefofstaff)"
RESEARCH_ID="$(agent_id_by_url_key researchscout)"
CODEX_ID="$(agent_id_by_url_key codexcoder)"
PLANNER_ID="$(agent_id_by_url_key productplanner)"
ARCHIVIST_ID="$(agent_id_by_url_key researcharchivist)"
UX_ID="$(agent_id_by_url_key uxuidesigner)"
FRONTEND_ID="$(agent_id_by_url_key frontendengineer)"
BACKEND_ID="$(agent_id_by_url_key backendengineer)"

if [[ -z "$CHIEF_ID" || -z "$RESEARCH_ID" || -z "$CODEX_ID" || -z "$PLANNER_ID" || -z "$ARCHIVIST_ID" || -z "$UX_ID" || -z "$FRONTEND_ID" || -z "$BACKEND_ID" ]]; then
  echo "failed to resolve one or more Paperclip agent ids" >&2
  exit 1
fi

LOWER_TEXT="$(printf '%s' "$REQUEST_TEXT" | tr '[:upper:]' '[:lower:]')"

ASSIGNEE_ID="$CHIEF_ID"
ASSIGNEE_NAME="ChiefOfStaff"
ROUTE_REASON="defaulted to operations coordination"
NEW_PROJECT_INTENT=0

if [[ "$LOWER_TEXT" =~ (source\ pack|evidence|citation|citations|references|reference|archive|raw\ source|1차\ 자료|출처|레퍼런스|근거\ 자료|자료\ 수집|아카이브) ]]; then
  ASSIGNEE_ID="$ARCHIVIST_ID"
  ASSIGNEE_NAME="ResearchArchivist"
  ROUTE_REASON="matched source gathering / evidence intent"
fi

if [[ "$ASSIGNEE_NAME" != "ResearchArchivist" && "$LOWER_TEXT" =~ (compare|pricing|price|latest|docs|documentation|vendor|research|recommend|recommendation|조사|비교|가격|최신|문서|업체|추천) ]]; then
  ASSIGNEE_ID="$RESEARCH_ID"
  ASSIGNEE_NAME="ResearchScout"
  ROUTE_REASON="matched research / comparison intent"
fi

if [[ "$LOWER_TEXT" =~ (ux|ui|wireframe|user\ flow|empty\ state|loading\ state|error\ state|screen\ flow|디자인|화면\ 구조|사용자\ 흐름|와이어프레임|상태\ 설계) ]]; then
  ASSIGNEE_ID="$UX_ID"
  ASSIGNEE_NAME="UXUIDesigner"
  ROUTE_REASON="matched ux / interface design intent"
fi

if [[ "$LOWER_TEXT" =~ (frontend|front-end|react|next\.js|component|route|client\ state|프론트엔드|프론트|컴포넌트|라우트|화면\ 구현) ]]; then
  ASSIGNEE_ID="$FRONTEND_ID"
  ASSIGNEE_NAME="FrontendEngineer"
  ROUTE_REASON="matched frontend implementation intent"
fi

if [[ "$LOWER_TEXT" =~ (backend|back-end|api|schema|database|db|worker|queue|auth|integration|백엔드|서버|인증|스키마|데이터베이스|잡\ 작업|연동) ]]; then
  ASSIGNEE_ID="$BACKEND_ID"
  ASSIGNEE_NAME="BackendEngineer"
  ROUTE_REASON="matched backend implementation intent"
fi

if [[ "$ASSIGNEE_NAME" == "ChiefOfStaff" && "$LOWER_TEXT" =~ (implement|setup|script|debug|fix|code|repo|automation|개발|구현|설치|스크립트|디버그|버그|코드|자동화) ]]; then
  ASSIGNEE_ID="$CODEX_ID"
  ASSIGNEE_NAME="CodexCoder"
  ROUTE_REASON="matched implementation / automation intent"
fi

if [[ "$LOWER_TEXT" =~ (requirements|requirement|scope|milestone|acceptance\ criteria|user\ story|prd|product\ plan|기획|요구사항|범위|마일스톤|우선순위|수용\ 기준|기능\ 정의) ]]; then
  ASSIGNEE_ID="$PLANNER_ID"
  ASSIGNEE_NAME="ProductPlanner"
  ROUTE_REASON="matched product planning / requirements intent"
fi

if [[ "$LOWER_TEXT" =~ (new\ project|project\ kickoff|kickoff|project\ start|start\ a\ project|새\ 프로젝트|프로젝트\ 시작|프로젝트\ 킥오프|프로젝트\ 만들|신규\ 프로젝트) ]]; then
  ASSIGNEE_ID="$CHIEF_ID"
  ASSIGNEE_NAME="ChiefOfStaff"
  ROUTE_REASON="matched new project / kickoff coordination intent"
  NEW_PROJECT_INTENT=1
fi

if [[ "$ASSIGNEE_NAME" == "ChiefOfStaff" && "$NEW_PROJECT_INTENT" -eq 0 && "$LOWER_TEXT" =~ (agenda|follow-up|follow up|checklist|plan|planning|remind|summary|status|meeting|일정|체크리스트|계획|플랜|리마인드|요약|상태|미팅|회의) ]]; then
  ASSIGNEE_ID="$CHIEF_ID"
  ASSIGNEE_NAME="ChiefOfStaff"
  ROUTE_REASON="matched operations / planning intent"
fi

TITLE_SOURCE="$(printf '%s' "$REQUEST_TEXT" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | sed 's/^ //; s/ $//')"
TITLE_TRIMMED="$(printf '%s' "$TITLE_SOURCE" | cut -c1-72)"
TITLE="Telegram intake: $TITLE_TRIMMED"

DESCRIPTION=$(jq -n \
  --arg req "$REQUEST_TEXT" \
  --arg owner "$ASSIGNEE_NAME" \
  --arg reason "$ROUTE_REASON" \
  '[
    "Source: Telegram via OpenClaw",
    "",
    "Original request:",
    $req,
    "",
    "Routing:",
    ("- Owner: " + $owner),
    ("- Reason: " + $reason)
  ] | join("\n")')

PAYLOAD=$(jq -n \
  --arg title "$TITLE" \
  --argjson description "$DESCRIPTION" \
  --arg assignee "$ASSIGNEE_ID" \
  --arg goalId "$GOAL_ID" \
  '{
    title: $title,
    description: $description,
    status: "todo",
    priority: "medium",
    assigneeAgentId: $assignee,
    goalId: $goalId
  }')

curl -sS \
  -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/issues" \
  -d "$PAYLOAD"
