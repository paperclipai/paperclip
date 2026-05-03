---
name: paperclip-dev
required: false
description: >
  로컬 Paperclip instance를 개발/운영할 때 쓰는 skill입니다.
  서버 시작/중지, master update, build/test, worktree, backup, diagnosis를 다룹니다.
---

# Paperclip Dev

이 skill은 Paperclip codebase 자체를 개발하고 로컬 instance를 운영하는 일상 workflow를 다룹니다.

## 공개 repo hygiene

이 repo는 public-facing입니다. secret, API key, token, private log, PII, customer data, machine-local config를 commit/push하지 마세요. throwaway branch나 noisy checkpoint commit도 피합니다.

## 필수 선행

CLI command, build, test, worktree 관리를 실행하기 전에 `doc/DEVELOPING.md`를 읽습니다. command flag를 추측하지 말고 canonical 문서를 확인합니다.

## 자주 쓰는 작업

- local server 시작/중지
- dependency 설치와 build
- typecheck/test 실행
- embedded database backup/reset
- Paperclip worktree 관리
- running instance diagnosis
- release/publishing 절차 확인

## 원칙

- local data와 production/shared data를 섞지 않습니다.
- database reset 전에는 경로를 다시 확인합니다.
- public push 전에 `git status`, staged diff, secret 여부를 확인합니다.
- failure는 숨기지 말고 command output과 함께 남깁니다.
