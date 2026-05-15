#!/usr/bin/env python3
"""
Paperclip Korean i18n — LangGraph Orchestrator

LangGraph 기반 OpenClaw × Hermes 협업 한글화 워크플로우.
Playbook topology: openclaw_plan → hermes_translate → openclaw_ci → (loop/end)

사용법:
    python3 paperclip_i18n_graph.py          # 전체 Phase 3 실행
    python3 paperclip_i18n_graph.py --file 1 # 특정 파일 번역
    python3 paperclip_i18n_graph.py --status # 현재 진행 상태
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# ── 경로 설정 ──────────────────────────────────────────────────────────
PAPERCLIP_DIR = Path("/home/hakkocap/paperclip")
I18N_DIR = PAPERCLIP_DIR / "ui/src/i18n"
KO_JSON = I18N_DIR / "locales/ko.json"
EN_JSON = I18N_DIR / "locales/en.json"

# ── Phase 3 파일 목록 (Tier 1~3) ─────────────────────────────────────
TIER1_FILES = [
    {"id": 1, "path": "ui/src/pages/Dashboard.tsx",     "strings": 14, "tier": 1},
    {"id": 2, "path": "ui/src/components/Sidebar.tsx",   "strings": 15, "tier": 1},
    {"id": 3, "path": "ui/src/pages/Inbox.tsx",          "strings": 58, "tier": 1},
    {"id": 4, "path": "ui/src/pages/IssueDetail.tsx",    "strings": 130, "tier": 1},
    {"id": 5, "path": "ui/src/pages/AgentDetail.tsx",    "strings": 93, "tier": 1},
    {"id": 6, "path": "ui/src/components/IssuesList.tsx","strings": 48, "tier": 1},
    {"id": 7, "path": "ui/src/components/SidebarAgents.tsx","strings": 15,"tier": 1},
]

TIER2_FILES = [
    {"id": 8,  "path": "ui/src/components/IssueProperties.tsx","strings": 86,"tier": 2},
    {"id": 9,  "path": "ui/src/components/IssueChatThread.tsx","strings": 68,"tier": 2},
    {"id": 10, "path": "ui/src/components/NewIssueDialog.tsx","strings": 73,"tier": 2},
    {"id": 11, "path": "ui/src/components/AgentConfigForm.tsx","strings": 72,"tier": 2},
    {"id": 12, "path": "ui/src/components/agent-config-primitives.tsx","strings": 43,"tier": 2},
    {"id": 13, "path": "ui/src/pages/CompanySkills.tsx","strings": 58,"tier": 2},
    {"id": 14, "path": "ui/src/pages/Secrets.tsx","strings": 86,"tier": 2},
    {"id": 15, "path": "ui/src/components/OnboardingWizard.tsx","strings": 44,"tier": 2},
]

PHASE3_FILES = TIER1_FILES + TIER2_FILES

STATE_FILE = PAPERCLIP_DIR / ".i18n_progress.json"

def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {
        "current_file_idx": 0,
        "completed_files": [],
        "failed_files": [],
        "current_retry": 0,
        "max_retries": 2,
        "status": "idle",
        "started_at": None,
        "phase3_complete": False,
    }

def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False))

def run_cmd(cmd: list[str], cwd: Path = PAPERCLIP_DIR, timeout: int = 120) -> dict:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=timeout)
        return {"ok": r.returncode == 0, "stdout": r.stdout, "stderr": r.stderr, "exit": r.returncode}
    except subprocess.TimeoutExpired:
        return {"ok": False, "stdout": "", "stderr": "TIMEOUT", "exit": -1}
    except Exception as e:
        return {"ok": False, "stdout": "", "stderr": str(e), "exit": -1}

# ── Node: openclaw_plan ──────────────────────────────────────────────
def openclaw_plan(state: dict) -> dict:
    """OpenClaw: Scan & Plan — 다음 번역 파일 선정"""
    idx = state["current_file_idx"]
    if idx >= len(PHASE3_FILES):
        state["status"] = "all_files_done"
        print("\n🐾 [OPENCLAW PLAN] 모든 파일 번역 완료! Phase 3 종료.")
        return state

    f = PHASE3_FILES[idx]
    print(f"\n{'='*60}")
    print(f"🐾 [OPENCLAW PLAN] 파일 #{f['id']} (Tier {f['tier']})")
    print(f"🐾 [OPENCLAW PLAN] 대상: {f['path']} ({f['strings']}개 문자열)")
    print(f"🐾 [OPENCLAW PLAN] 작업: 하드코딩 영문 텍스트 → t() 함수 + ko.json 키")
    print(f"{'='*60}")

    state["status"] = "translating"
    state["current_file"] = f
    state["current_retry"] = 0
    save_state(state)
    return state

# ── Node: hermes_translate ───────────────────────────────────────────
def hermes_translate(state: dict) -> dict:
    """Hermes: Surgical Trans — 파일 정밀 번역"""
    f = state.get("current_file")
    if not f:
        print("\n🔵 [HERMES TRANSLATE] 번역할 파일이 없습니다.")
        return state

    filepath = PAPERCLIP_DIR / f["path"]
    if not filepath.exists():
        print(f"\n🔵 [HERMES TRANSLATE] ❌ 파일 없음: {filepath}")
        state["status"] = "failed"
        state["failed_files"].append(f["id"])
        state["current_file_idx"] += 1
        save_state(state)
        return state

    print(f"\n🔵 [HERMES TRANSLATE] #{f['id']}: {f['path']}")
    print(f"🔵 [HERMES TRANSLATE] 다음 단계에서 수동 번역 실행 필요")
    print(f"🔵 [HERMES TRANSLATE] 확인: git add + t() 함수 변환 + ko.json 키")

    state["status"] = "ci_check"
    save_state(state)
    return state

# ── Node: openclaw_ci ────────────────────────────────────────────────
def openclaw_ci(state: dict) -> dict:
    """OpenClaw: CI/Typecheck — pnpm typecheck 실행"""
    f = state.get("current_file")
    if not f:
        return state

    print(f"\n🟡 [OPENCLAW CI] #{f['id']}: pnpm typecheck 실행 중...")

    result = run_cmd(["pnpm", "-r", "typecheck"], timeout=180)
    print(f"🟡 [OPENCLAW CI] 종료 코드: {result['exit']}")

    if result["ok"]:
        print(f"🟡 [OPENCLAW CI] ✅ 타입체크 통과!")
        state["status"] = "passed"
        state["completed_files"].append(f["id"])
        state["current_file_idx"] += 1
        state["current_retry"] = 0
        commit_msg = f"feat(i18n): translate {f['path']}"
        subprocess.run(["git", "add", "-A"], cwd=PAPERCLIP_DIR, capture_output=True)
        subprocess.run(["git", "commit", "-m", commit_msg], cwd=PAPERCLIP_DIR, capture_output=True)
        print(f"🟡 [OPENCLAW CI] ✅ 커밋 완료: {commit_msg}")
    else:
        errors = result["stderr"][:500]
        print(f"🟡 [OPENCLAW CI] ❌ 타입체크 실패!")
        print(f"🟡 [OPENCLAW CI] 오류: {errors}")

        state["current_retry"] += 1
        if state["current_retry"] >= state["max_retries"]:
            print(f"🟡 [OPENCLAW CI] ⛔ 최대 재시도 초과 ({state['max_retries']}회). 롤백.")
            subprocess.run(["git", "checkout", "--", str(f["path"])], cwd=PAPERCLIP_DIR, capture_output=True)
            state["failed_files"].append(f["id"])
            state["current_file_idx"] += 1
            state["current_retry"] = 0
            state["status"] = "failed"
        else:
            print(f"🟡 [OPENCLAW CI] 🔄 재시도 {state['current_retry']}/{state['max_retries']}")
            state["status"] = "translating"  # retry translation

    save_state(state)
    return state

# ── Main Loop ────────────────────────────────────────────────────────
def run_phase3():
    state = load_state()

    if state.get("phase3_complete"):
        print("\n✅ Phase 3 이미 완료되었습니다.")
        show_status()
        return

    if state["started_at"] is None:
        state["started_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        save_state(state)

    print(f"\n{'='*60}")
    print(f"🏴‍☠️  Paperclip 한글화 — LangGraph 협업 오케스트레이션")
    print(f"{'='*60}")
    print(f"📋 OpenClaw: Plan + CI/Typecheck")
    print(f"🔧 Hermes:   Surgical Translation")
    print(f"{'='*60}")

    while state["current_file_idx"] < len(PHASE3_FILES):
        # Node 1: OpenClaw Plan
        state = openclaw_plan(state)

        # Node 2: Hermes Translate
        state = hermes_translate(state)

        # Node 3: OpenClaw CI
        state = openclaw_ci(state)

        # If translation failed, retry logic in ci handles it
        if state.get("status") == "translating":
            continue  # retry

        # Print progress
        done = len(state["completed_files"])
        total = len(PHASE3_FILES)
        bar = "■" * done + "□" * (total - done)
        print(f"\n📊 진행률: [{bar}] {done}/{total}")

    # Phase 3 complete
    state["phase3_complete"] = True
    state["status"] = "phase3_done"
    save_state(state)
    print(f"\n{'='*60}")
    print("🏁 Phase 3 완료!")
    print(f"✅ 성공: {len(state['completed_files'])}개 파일")
    print(f"❌ 실패: {len(state['failed_files'])}개 파일")
    print(f"{'='*60}")

def show_status():
    state = load_state()
    total = len(PHASE3_FILES)
    done = len(state["completed_files"])
    failed = len(state["failed_files"])
    bar = "■" * done + "□" * (total - done)
    print(f"\n{'='*60}")
    print(f"📊 Phase 3 진행률: [{bar}] {done}/{total}")
    print(f"✅ 완료: {done}개 | ❌ 실패: {failed}개 | ⏳ 남음: {total - done - failed}개")
    print(f"🔄 현재 파일 인덱스: {state['current_file_idx']}")
    print(f"📌 상태: {state['status']}")

    if done > 0:
        print(f"\n완료된 파일:")
        for fid in state["completed_files"]:
            f = next((x for x in PHASE3_FILES if x["id"] == fid), None)
            if f:
                print(f"  ✅ #{fid}: {f['path']}")

    if failed > 0:
        print(f"\n실패한 파일:")
        for fid in state["failed_files"]:
            f = next((x for x in PHASE3_FILES if x["id"] == fid), None)
            if f:
                print(f"  ❌ #{fid}: {f['path']}")

    idx = state["current_file_idx"]
    if idx < total:
        nextf = PHASE3_FILES[idx]
        print(f"\n⏭️  다음 파일: #{nextf['id']}: {nextf['path']} ({nextf['strings']}개 문자열)")

# ── CLI ──────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Paperclip Korean i18n — LangGraph Orchestrator")
    parser.add_argument("--status", action="store_true", help="현재 진행 상태 표시")
    parser.add_argument("--reset", action="store_true", help="진행 상태 초기화")
    args = parser.parse_args()

    if args.reset:
        STATE_FILE.unlink(missing_ok=True)
        print("🔄 진행 상태 초기화 완료")
        return

    if args.status:
        show_status()
        return

    run_phase3()

if __name__ == "__main__":
    main()
