#!/usr/bin/env python3
"""
company repo 운영용 CLI.

Daily Focus, Cycle, Chapter 생성에 집중한다.
"""

from __future__ import annotations

import argparse
import datetime as dt
import pathlib
import re
from typing import Dict, List, Optional


ROOT = pathlib.Path(__file__).resolve().parents[2]
DAILY_DIR = ROOT / "daily"
OPERATIONS_DIR = ROOT / "operations"
ROADMAP_DIR = ROOT / "roadmap"
DEFAULT_MEMBERS = ["대환", "지수", "상훈"]


def seoul_today() -> dt.date:
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date()


def normalize_text(value: Optional[str]) -> str:
    if value is None:
        return ""
    return str(value).strip()


def ensure_parent(path: pathlib.Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def daily_file_path(target_date: dt.date) -> pathlib.Path:
    return DAILY_DIR / str(target_date.year) / f"{target_date.isoformat()}-daily-focus.md"


def legacy_daily_sprint_file_path(target_date: dt.date) -> pathlib.Path:
    return DAILY_DIR / str(target_date.year) / f"{target_date.isoformat()}-daily-sprint.md"


def chapter_file_path(year: int, number: int) -> pathlib.Path:
    return ROADMAP_DIR / "chapters" / str(year) / f"{year}-chapter-{number}.md"


def slugify(value: str) -> str:
    lowered = value.strip().lower()
    lowered = re.sub(r"[^a-z0-9]+", "-", lowered)
    lowered = re.sub(r"-{2,}", "-", lowered).strip("-")
    return lowered or "cycle"


def cycle_file_path(year: int, cycle_title: str) -> pathlib.Path:
    return OPERATIONS_DIR / "cycles" / str(year) / f"{slugify(cycle_title)}.md"


def parse_key_value_line(line: str) -> Optional[tuple[str, str]]:
    stripped = line.strip()
    if not stripped.startswith("- "):
        return None
    payload = stripped[2:]
    if ":" not in payload:
        return None
    key, value = payload.split(":", 1)
    return key.strip(), value.strip()


def parse_cycle_goals(cycle_file: pathlib.Path) -> List[Dict[str, str]]:
    if not cycle_file.exists():
        raise SystemExit(f"Cycle 파일이 없습니다: {cycle_file}")

    goals: List[Dict[str, str]] = []
    section = ""
    current: Optional[Dict[str, str]] = None

    for raw_line in cycle_file.read_text(encoding="utf-8").splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("## "):
            if current:
                goals.append(current)
            section = stripped[3:].strip()
            current = None
            continue
        if section != "이번 주 Must-win Goals":
            continue
        if stripped.startswith("- Goal "):
            if current:
                goals.append(current)
            _, value = stripped[2:].split(":", 1)
            current = {
                "title": value.strip(),
                "owner": "",
                "progress": "",
                "link": "",
            }
            continue
        if current and stripped.startswith("- "):
            parsed = parse_key_value_line(stripped)
            if not parsed:
                continue
            key, value = parsed
            if key == "담당":
                current["owner"] = value
            elif key == "진행도":
                current["progress"] = value
            elif key == "연결 Linear Project / Issue":
                current["link"] = value

    if current:
        goals.append(current)

    return goals[:3]


def parse_previous_daily(previous_file: pathlib.Path) -> Dict[str, Dict[str, str]]:
    if not previous_file.exists():
        return {}

    people: Dict[str, Dict[str, str]] = {}
    section = ""
    current_person: Optional[str] = None

    for raw_line in previous_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()

        if stripped.startswith("## "):
            section = stripped[3:].strip()
            current_person = None
            continue
        if stripped.startswith("### "):
            current_person = stripped[4:].strip()
            people.setdefault(current_person, {})
            continue
        parsed = parse_key_value_line(line)
        if not parsed or not current_person:
            continue

        key, value = parsed
        bucket = people.setdefault(current_person, {})

        if section == "오늘 최우선 목표":
            if key == "최우선":
                bucket["previous_goal"] = value
            elif key == "관련 Linear Issue":
                bucket["previous_issue"] = value
        elif section == "저녁 마감 체크":
            if key == "실제 결과":
                bucket["actual_result"] = value
            elif key == "완료 / 미완료":
                bucket["completion"] = value
            elif key == "미완료 이유":
                bucket["incomplete_reason"] = value
            elif key == "내일 첫 액션":
                bucket["next_action"] = value
        elif section == "전일 목표 체크":
            if key == "전일 목표" and "previous_goal" not in bucket:
                bucket["previous_goal"] = value
            elif key == "관련 Linear Issue" and "previous_issue" not in bucket:
                bucket["previous_issue"] = value
            elif key == "실제 결과" and "actual_result" not in bucket:
                bucket["actual_result"] = value
            elif key == "완료 여부" and "completion" not in bucket:
                bucket["completion"] = value
            elif key == "이월 여부":
                bucket["carryover"] = value

    return people


def infer_carryover(entry: Dict[str, str]) -> bool:
    completion = normalize_text(entry.get("completion")).lower()
    carryover = normalize_text(entry.get("carryover")).lower()
    if carryover in {"y", "yes", "예", "있음", "true"}:
        return True
    if not completion:
        return False
    return "완료" not in completion or "미완료" in completion


def member_block(name: str, previous: Dict[str, str]) -> str:
    carry = infer_carryover(previous)
    today_goal = previous.get("previous_goal", "") if carry else ""
    today_issue = previous.get("previous_issue", "") if carry else ""
    first_action = previous.get("next_action", "") if carry else ""

    return "\n".join(
        [
            f"### {name}",
            "",
            f"- 최우선: {today_goal}",
            f"- 관련 Linear Issue: {today_issue}",
            "- 완료 기준: ",
            f"- 첫 액션: {first_action}",
            "- 요청/막힘: ",
        ]
    )


def render_daily_sprint(
    *,
    target_date: dt.date,
    chapter: str,
    cycle: str,
    members: List[str],
    weekly_goals: List[Dict[str, str]],
    previous_people: Dict[str, Dict[str, str]],
) -> str:
    weekly_lines: List[str] = []
    for index in range(3):
        goal = weekly_goals[index] if index < len(weekly_goals) else {}
        weekly_lines.extend(
            [
                f"- Must-win goal {index + 1}: {goal.get('title', '')}",
                f"  - 상태: {goal.get('status', '')}",
                f"  - 진행도: {goal.get('progress', '')}",
                f"  - 연결 Linear Project: {goal.get('link', '')}",
            ]
        )

    previous_lines: List[str] = []
    carryover_lines: List[str] = []
    for name in members:
        entry = previous_people.get(name, {})
        carry = "예" if infer_carryover(entry) else ""
        if carry:
            carryover_lines.append(
                f"- {name}: {entry.get('previous_goal', '')} ({entry.get('previous_issue', '')})"
            )
        previous_lines.extend(
            [
                f"### {name}",
                "",
                f"- 전일 목표: {entry.get('previous_goal', '')}",
                f"- 관련 Linear Issue: {entry.get('previous_issue', '')}",
                f"- 실제 결과: {entry.get('actual_result', '')}",
                f"- 완료 여부: {entry.get('completion', '')}",
                f"- 이월 여부: {carry}",
                "",
            ]
        )

    member_sections = "\n\n".join(
        member_block(name, previous_people.get(name, {})) for name in members
    )

    closing_sections = "\n\n".join(
        "\n".join(
            [
                f"### {name}",
                "",
                "- 실제 결과: ",
                "- 완료 / 미완료: ",
                "- 미완료 이유: ",
                "- 내일 첫 액션: ",
            ]
        )
        for name in members
    )

    carryover_text = "\n".join(carryover_lines) if carryover_lines else "- "

    lines = [
        "# Daily Focus 템플릿",
        "",
        "## 문서 제목",
        "",
        f"- `{target_date.isoformat()} Daily Focus`",
        "",
        "## 기본 정보",
        "",
        f"- 날짜: {target_date.isoformat()}",
        f"- 연결 Chapter: {chapter}",
        f"- 연결 Cycle: {cycle}",
        f"- 참가자: {', '.join(members)}",
        "- 오늘의 한 줄 초점: ",
        "",
        "## 이번 주 Progress",
        "",
        *weekly_lines,
        "",
        "## 전일 목표 체크",
        "",
        *previous_lines,
        "## 아침 공유",
        "",
        "- 오늘 팀 공통 초점: ",
        "- 오늘 꼭 맞춰야 할 일정/회의: ",
        "- 오늘 필요한 결정: ",
        "",
        "## 요청 / 막힘",
        "",
        "- ",
        "",
        "## 오늘 최우선 목표",
        "",
        member_sections,
        "",
        "## 저녁 마감 체크",
        "",
        closing_sections,
        "",
        "## 내일로 넘길 것",
        "",
        carryover_text,
        "",
    ]
    return "\n".join(lines)


def render_cycle(
    *,
    cycle: str,
    chapter: str,
    initiative: str,
    week: str,
    focus: str,
    status: str,
    update_targets: List[str],
    goals: List[str],
) -> str:
    goal_lines: List[str] = []
    for index in range(3):
        goal = goals[index] if index < len(goals) else ""
        goal_lines.extend(
            [
                f"- Goal {index + 1}: {goal}",
                "  - 담당: ",
                "  - 진행도: ",
                "  - 연결 Linear Project / Issue: ",
            ]
        )

    lines = [
        "# Weekly Cycle 템플릿",
        "",
        "## 문서 제목",
        "",
        f"- `{cycle}`",
        "",
        "## 기본 정보",
        "",
        "- 회의 시점: `매주 첫날`",
        f"- 기준 주간: {week}",
        f"- 연결 Chapter: {chapter}",
        f"- 연결 Linear Initiative: {initiative}",
        f"- 이번 주 초점 한 줄: {focus}",
        f"- 상태: `{status}`",
        "- 연결 Linear Cycle: ",
        f"- 이번 주 Project Update 대상: {', '.join(update_targets)}",
        "",
        "## 지난주 Carryover",
        "",
        "- ",
        "",
        "## 이번 주 Must-win Goals",
        "",
        *goal_lines,
        "",
        "## 이번 주 핵심 이슈",
        "",
        "- ",
        "",
        "## 현재 막힘 / 필요한 결정",
        "",
        "- 이슈:",
        "  - 필요한 결정:",
        "  - 담당:",
        "  - 기한:",
        "",
        "## 이번 주 결정",
        "",
        "- ",
        "",
        "## 다음 주 1~3개",
        "",
        "- ",
        "- ",
        "- ",
        "",
        "## 금요일 마감 체크",
        "",
        "- Goal 1:",
        "- Goal 2:",
        "- Goal 3:",
        "- 남은 Carryover:",
        "- Project Update 반영 여부:",
        "",
        "## 메모",
        "",
        "- ",
        "",
        "## 운영 메모",
        "",
        "- 이 문서는 `매주 첫날 여는 Cycle 회의` 기록용이다",
        "- 노션과 Linear에서 같은 `Cycle` 이름을 사용한다",
        "",
    ]
    return "\n".join(lines)


def render_chapter(
    *,
    year: int,
    number: int,
    period: str,
    theme: str,
    initiative: str,
    outsourcing_ratio: str,
    engine_ratio: str,
    game_ratio: str,
    not_doing: List[str],
) -> str:
    not_doing_lines = not_doing or [""]
    bullet_lines = [f"- {item}" if item else "- " for item in not_doing_lines]

    lines = [
        "# Chapter 템플릿",
        "",
        "## 문서 제목",
        "",
        f"- `{year} Chapter {number}`",
        "",
        "## 기본 정보",
        "",
        f"- 기간: {period}",
        f"- 챕터 테마 한 줄: {theme}",
        f"- 연결 Linear Initiative: {initiative}",
        "- 이번 챕터에서 하지 않을 것:",
        *bullet_lines,
        f"- 리소스 배분: 외주 {outsourcing_ratio} / 제품·엔진 {engine_ratio} / 게임 투자 {game_ratio}",
        "",
        "## 이번 Chapter에서 달라질 상태",
        "",
        "### Goal 1",
        "",
        "- 이름: ",
        "- 끝나면 달라지는 상태: ",
        "- Owner: ",
        "- 연결 Linear Project: ",
        "",
        "### Goal 2",
        "",
        "- 이름: ",
        "- 끝나면 달라지는 상태: ",
        "- Owner: ",
        "- 연결 Linear Project: ",
        "",
        "### Goal 3 (Optional)",
        "",
        "- 이름: ",
        "- 끝나면 달라지는 상태: ",
        "- Owner: ",
        "- 연결 Linear Project: ",
        "",
        "## 챕터 종료 시 확인할 것",
        "",
        "- 실제로 달라진 상태: ",
        "- 못 끝낸 이유: ",
        "- 다음 챕터로 넘길 것: ",
        "",
        "## 메모",
        "",
        "- ",
        "",
    ]
    return "\n".join(lines)


def cmd_daily_sprint_create(args: argparse.Namespace) -> None:
    target_date = dt.date.fromisoformat(args.date) if args.date else seoul_today()
    members = [name.strip() for name in args.members.split(",") if name.strip()] or DEFAULT_MEMBERS
    output_path = pathlib.Path(args.output).expanduser() if args.output else daily_file_path(target_date)

    if output_path.exists() and not args.force:
        raise SystemExit(f"이미 파일이 있습니다: {output_path}")

    previous_file = daily_file_path(target_date - dt.timedelta(days=1))
    if not previous_file.exists():
        legacy_previous = legacy_daily_sprint_file_path(target_date - dt.timedelta(days=1))
        if legacy_previous.exists():
            previous_file = legacy_previous
    previous_people = parse_previous_daily(previous_file)

    weekly_goals: List[Dict[str, str]] = []
    cycle_file: Optional[pathlib.Path] = None
    if args.cycle_file:
        cycle_file = pathlib.Path(args.cycle_file).expanduser()
    elif args.cycle:
        inferred = cycle_file_path(target_date.year, args.cycle)
        if inferred.exists():
            cycle_file = inferred
    if cycle_file:
        weekly_goals = parse_cycle_goals(cycle_file)

    for goal_text in args.goal:
        if len(weekly_goals) >= 3:
            break
        weekly_goals.append(
            {
                "title": goal_text,
                "status": "",
                "progress": "",
                "link": "",
            }
        )

    content = render_daily_sprint(
        target_date=target_date,
        chapter=args.chapter,
        cycle=args.cycle,
        members=members,
        weekly_goals=weekly_goals,
        previous_people=previous_people,
    )
    ensure_parent(output_path)
    output_path.write_text(content, encoding="utf-8")
    print(output_path)


def cmd_cycle_create(args: argparse.Namespace) -> None:
    year = args.year or seoul_today().year
    output_path = pathlib.Path(args.output).expanduser() if args.output else cycle_file_path(year, args.cycle)

    if output_path.exists() and not args.force:
        raise SystemExit(f"이미 파일이 있습니다: {output_path}")

    content = render_cycle(
        cycle=args.cycle,
        chapter=args.chapter,
        initiative=args.initiative,
        week=args.week,
        focus=args.focus,
        status=args.status,
        update_targets=args.update_target,
        goals=args.goal[:3],
    )
    ensure_parent(output_path)
    output_path.write_text(content, encoding="utf-8")
    print(output_path)


def cmd_chapter_create(args: argparse.Namespace) -> None:
    year = args.year or seoul_today().year
    output_path = pathlib.Path(args.output).expanduser() if args.output else chapter_file_path(year, args.number)

    if output_path.exists() and not args.force:
        raise SystemExit(f"이미 파일이 있습니다: {output_path}")

    content = render_chapter(
        year=year,
        number=args.number,
        period=args.period,
        theme=args.theme,
        initiative=args.initiative,
        outsourcing_ratio=args.outsourcing_ratio,
        engine_ratio=args.engine_ratio,
        game_ratio=args.game_ratio,
        not_doing=args.not_doing,
    )
    ensure_parent(output_path)
    output_path.write_text(content, encoding="utf-8")
    print(output_path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="company 운영 CLI")
    subparsers = parser.add_subparsers(dest="area", required=True)

    daily_parser = subparsers.add_parser("daily-focus", aliases=["daily-sprint"], help="Daily Focus 생성")
    daily_subparsers = daily_parser.add_subparsers(dest="action", required=True)

    daily_create_parser = daily_subparsers.add_parser("create", help="Daily Focus 문서 생성")
    daily_create_parser.add_argument("--date", default=None, help="기준 날짜. 예: 2026-03-16")
    daily_create_parser.add_argument("--chapter", default="", help="연결 Chapter")
    daily_create_parser.add_argument("--cycle", default="", help="연결 Cycle")
    daily_create_parser.add_argument("--cycle-file", default=None, help="이번 주 Cycle markdown 파일 경로")
    daily_create_parser.add_argument("--goal", action="append", default=[], help="Cycle 파일 대신 직접 넣을 주간 목표")
    daily_create_parser.add_argument(
        "--members",
        default=",".join(DEFAULT_MEMBERS),
        help="쉼표로 구분한 참가자 목록",
    )
    daily_create_parser.add_argument("--output", default=None, help="출력 파일 경로")
    daily_create_parser.add_argument("--force", action="store_true", help="기존 파일 덮어쓰기")
    daily_create_parser.set_defaults(func=cmd_daily_sprint_create)

    cycle_parser = subparsers.add_parser("cycle", help="Cycle 문서 생성")
    cycle_subparsers = cycle_parser.add_subparsers(dest="action", required=True)

    cycle_create_parser = cycle_subparsers.add_parser("create", help="Cycle 문서 생성")
    cycle_create_parser.add_argument("--year", type=int, default=None, help="연도. 기본값은 현재 연도")
    cycle_create_parser.add_argument("--cycle", required=True, help='예: "C2 Cycle 3"')
    cycle_create_parser.add_argument("--chapter", default="", help='예: "2026 Chapter 2"')
    cycle_create_parser.add_argument("--initiative", default="", help='예: "Superbuilder Shipment Engine"')
    cycle_create_parser.add_argument("--week", default="", help='예: "2026-03-16 ~ 2026-03-22"')
    cycle_create_parser.add_argument("--focus", default="", help="이번 주 초점 한 줄")
    cycle_create_parser.add_argument("--status", default="On track", help="On track / At risk / Off track")
    cycle_create_parser.add_argument("--goal", action="append", default=[], help="이번 주 Must-win goal")
    cycle_create_parser.add_argument("--update-target", action="append", default=[], help="이번 주 Project Update 대상")
    cycle_create_parser.add_argument("--output", default=None, help="출력 파일 경로")
    cycle_create_parser.add_argument("--force", action="store_true", help="기존 파일 덮어쓰기")
    cycle_create_parser.set_defaults(func=cmd_cycle_create)

    chapter_parser = subparsers.add_parser("chapter", help="Chapter 문서 생성")
    chapter_subparsers = chapter_parser.add_subparsers(dest="action", required=True)

    chapter_create_parser = chapter_subparsers.add_parser("create", help="Chapter 문서 생성")
    chapter_create_parser.add_argument("--year", type=int, default=None, help="연도. 기본값은 현재 연도")
    chapter_create_parser.add_argument("--number", type=int, required=True, help="챕터 번호")
    chapter_create_parser.add_argument("--period", default="", help='예: "2026-03-01 ~ 2026-04-30"')
    chapter_create_parser.add_argument("--theme", default="", help="챕터 테마 한 줄")
    chapter_create_parser.add_argument("--initiative", default="", help='예: "Superbuilder Shipment Engine"')
    chapter_create_parser.add_argument("--outsourcing-ratio", default="__%", help="외주 비중")
    chapter_create_parser.add_argument("--engine-ratio", default="__%", help="제품·엔진 비중")
    chapter_create_parser.add_argument("--game-ratio", default="__%", help="게임 투자 비중")
    chapter_create_parser.add_argument("--not-doing", action="append", default=[], help="이번 챕터에서 하지 않을 것")
    chapter_create_parser.add_argument("--output", default=None, help="출력 파일 경로")
    chapter_create_parser.add_argument("--force", action="store_true", help="기존 파일 덮어쓰기")
    chapter_create_parser.set_defaults(func=cmd_chapter_create)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
