#!/usr/bin/env python3
"""
GitHub 조직/저장소의 일간 작업 상태를 수집하는 스크립트.

환경변수:
- GITHUB_TOKEN
- GITHUB_WORK_ORGS
- GITHUB_WORK_REPOS
- GITHUB_REPO_EXCLUDE_PATTERNS
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Optional


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/145.0.0.0 Safari/537.36"
)

GITHUB_API_BASE = "https://api.github.com"


def require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} 가 비어 있습니다.")
    return value


def github_get(path: str, params: Optional[Dict[str, Any]] = None) -> Any:
    token = require_env("GITHUB_TOKEN")
    query = ""
    if params:
        query = "?" + urllib.parse.urlencode(params, doseq=True)
    url = f"{GITHUB_API_BASE}{path}{query}"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GET {url} 실패: {exc.code} {body}") from exc


def paginate(path: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    page = 1
    items: List[Dict[str, Any]] = []
    while True:
        local_params = dict(params or {})
        local_params.setdefault("per_page", 100)
        local_params["page"] = page
        batch = github_get(path, local_params)
        if not isinstance(batch, list):
            raise RuntimeError(f"리스트 응답이 아닙니다: {path}")
        if not batch:
            break
        items.extend(batch)
        if len(batch) < local_params["per_page"]:
            break
        page += 1
    return items


def parse_date_range(date_text: str) -> tuple[str, str]:
    local_date = dt.date.fromisoformat(date_text)
    start = dt.datetime.combine(local_date, dt.time.min, tzinfo=dt.timezone(dt.timedelta(hours=9)))
    end = start + dt.timedelta(days=1)
    return start.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"), end.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def repo_excluded(repo_full_name: str, exclude_patterns: Iterable[str]) -> bool:
    return any(pattern and pattern in repo_full_name for pattern in exclude_patterns)


def get_target_repos() -> List[str]:
    explicit_repos = [
        repo.strip()
        for repo in os.getenv("GITHUB_WORK_REPOS", "").split(",")
        if repo.strip()
    ]
    exclude_patterns = [
        pattern.strip()
        for pattern in os.getenv("GITHUB_REPO_EXCLUDE_PATTERNS", "").split(",")
        if pattern.strip()
    ]
    if explicit_repos:
        return [
            repo for repo in explicit_repos if not repo_excluded(repo, exclude_patterns)
        ]

    orgs = [
        org.strip()
        for org in os.getenv("GITHUB_WORK_ORGS", "").split(",")
        if org.strip()
    ]
    repos: List[str] = []
    for org in orgs:
        for repo in paginate(f"/orgs/{org}/repos", {"type": "all"}):
            full_name = repo.get("full_name") or repo.get("nameWithOwner")
            if full_name and not repo_excluded(full_name, exclude_patterns):
                repos.append(full_name)
    return sorted(set(repos))


def within_range(timestamp: Optional[str], start_iso: str, end_iso: str) -> bool:
    if not timestamp:
        return False
    return start_iso <= timestamp <= end_iso


def fetch_repo_activity(repo_full_name: str, start_iso: str, end_iso: str) -> Dict[str, Any]:
    owner, repo = repo_full_name.split("/", 1)
    try:
        commits = paginate(
            f"/repos/{owner}/{repo}/commits",
            {"since": start_iso, "until": end_iso},
        )
    except RuntimeError as exc:
        message = str(exc)
        if "Git Repository is empty" in message or " 409 " in message:
            commits = []
        else:
            raise
    pulls = paginate(
        f"/repos/{owner}/{repo}/pulls",
        {"state": "all", "sort": "updated", "direction": "desc"},
    )

    filtered_pulls = []
    for pull in pulls:
        updated_at = pull.get("updated_at")
        created_at = pull.get("created_at")
        merged_at = pull.get("merged_at")
        closed_at = pull.get("closed_at")
        if any(
            within_range(value, start_iso, end_iso)
            for value in (updated_at, created_at, merged_at, closed_at)
        ):
            filtered_pulls.append(pull)
        elif updated_at and updated_at < start_iso:
            break

    return {"commits": commits, "pulls": filtered_pulls}


def login_from_commit(commit: Dict[str, Any]) -> str:
    author = commit.get("author") or {}
    if author.get("login"):
        return author["login"]
    commit_author = ((commit.get("commit") or {}).get("author") or {}).get("name")
    return commit_author or "unknown"


def summarize(repos: List[str], activities: Dict[str, Any], date_text: str) -> Dict[str, Any]:
    people: Dict[str, Any] = defaultdict(
        lambda: {
            "commits": 0,
            "pull_requests": 0,
            "merged_prs": 0,
            "repos": set(),
            "recent_commits": [],
            "prs": [],
        }
    )
    repo_summary = []

    for repo in repos:
        activity = activities[repo]
        commits = activity["commits"]
        pulls = activity["pulls"]
        repo_summary.append(
            {
                "repo": repo,
                "commits": len(commits),
                "pull_requests": len(pulls),
            }
        )

        for commit in commits:
            login = login_from_commit(commit)
            people[login]["commits"] += 1
            people[login]["repos"].add(repo)
            people[login]["recent_commits"].append(
                {
                    "repo": repo,
                    "sha": (commit.get("sha") or "")[:7],
                    "message": ((commit.get("commit") or {}).get("message") or "").split("\n")[0],
                    "url": commit.get("html_url"),
                }
            )

        for pull in pulls:
            login = ((pull.get("user") or {}).get("login")) or "unknown"
            people[login]["pull_requests"] += 1
            if pull.get("merged_at"):
                people[login]["merged_prs"] += 1
            people[login]["repos"].add(repo)
            people[login]["prs"].append(
                {
                    "repo": repo,
                    "number": pull.get("number"),
                    "title": pull.get("title"),
                    "state": pull.get("state"),
                    "merged_at": pull.get("merged_at"),
                    "html_url": pull.get("html_url"),
                }
            )

    normalized_people = []
    for login, payload in people.items():
        normalized_people.append(
            {
                "login": login,
                "commits": payload["commits"],
                "pull_requests": payload["pull_requests"],
                "merged_prs": payload["merged_prs"],
                "repos": sorted(payload["repos"]),
                "recent_commits": payload["recent_commits"][:10],
                "prs": payload["prs"][:10],
            }
        )
    normalized_people.sort(
        key=lambda item: (item["commits"] + item["pull_requests"], item["commits"]),
        reverse=True,
    )
    repo_summary.sort(
        key=lambda item: (item["commits"] + item["pull_requests"], item["commits"]),
        reverse=True,
    )

    return {
        "date": date_text,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "repos_scanned": repos,
        "people": normalized_people,
        "repo_summary": repo_summary,
    }


def render_markdown(summary: Dict[str, Any]) -> str:
    lines = [
        "# GitHub 일간 작업 상태",
        "",
        f"- 기준일: `{summary['date']}`",
        f"- 생성 시각(UTC): `{summary['generated_at']}`",
        f"- 스캔한 저장소 수: `{len(summary['repos_scanned'])}`",
        "",
        "## 사람별 활동",
        "",
    ]

    if not summary["people"]:
        lines.append("- 활동이 감지되지 않았습니다.")
    else:
        for person in summary["people"]:
            lines.extend(
                [
                    f"### {person['login']}",
                    f"- 커밋: `{person['commits']}`",
                    f"- PR 변화: `{person['pull_requests']}`",
                    f"- 머지된 PR: `{person['merged_prs']}`",
                    f"- 작업 저장소: `{', '.join(person['repos'])}`" if person["repos"] else "- 작업 저장소: 없음",
                ]
            )
            if person["recent_commits"]:
                lines.append("- 최근 커밋:")
                for commit in person["recent_commits"][:5]:
                    lines.append(
                        f"  - {commit['repo']} `{commit['sha']}` {commit['message']}"
                    )
            if person["prs"]:
                lines.append("- 관련 PR:")
                for pull in person["prs"][:5]:
                    merged_text = " | merged" if pull.get("merged_at") else ""
                    lines.append(
                        f"  - {pull['repo']} #{pull['number']} {pull['title']} | {pull['state']}{merged_text}"
                    )
            lines.append("")

    lines.extend(["## 저장소별 활동", ""])
    for repo in summary["repo_summary"][:20]:
        lines.append(
            f"- {repo['repo']} | 커밋 `{repo['commits']}` | PR 변화 `{repo['pull_requests']}`"
        )

    lines.extend(
        [
            "",
            "## 해석 메모",
            "",
            "- GitHub는 실제 코드 움직임을 보여준다",
            "- 하지만 기획, 회의, 조사, 고객 대응은 GitHub에 다 드러나지 않는다",
            "- 따라서 `Linear + GitHub + 회의록`을 같이 봐야 실제 작업 상태가 보인다",
            "",
        ]
    )
    return "\n".join(lines)


def save_snapshot(save_dir: Optional[str], summary: Dict[str, Any], markdown: str) -> None:
    if not save_dir:
        return
    path = pathlib.Path(save_dir)
    path.mkdir(parents=True, exist_ok=True)
    (path / "github-work-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (path / "github-work-summary.md").write_text(markdown, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GitHub 일간 작업 상태 수집")
    parser.add_argument("--date", help="YYYY-MM-DD. 기본값은 오늘(Asia/Seoul)")
    parser.add_argument("--save-dir", help="스냅샷 저장 경로")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    local_now = dt.datetime.now(dt.timezone(dt.timedelta(hours=9)))
    date_text = args.date or local_now.date().isoformat()
    start_iso, end_iso = parse_date_range(date_text)
    repos = get_target_repos()
    activities: Dict[str, Any] = {}
    for repo in repos:
        activities[repo] = fetch_repo_activity(repo, start_iso, end_iso)

    summary = summarize(repos, activities, date_text)
    markdown = render_markdown(summary)
    save_snapshot(args.save_dir, summary, markdown)

    if args.format == "json":
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(markdown)
    return 0


if __name__ == "__main__":
    sys.exit(main())
