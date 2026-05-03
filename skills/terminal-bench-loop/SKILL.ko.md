---
name: terminal-bench-loop
description: >
  Terminal-Bench 문제 하나를 Paperclip 안에서 bounded human-in-the-loop 방식으로 반복 실행하는 skill입니다.
  smoke, diagnosis, board confirmation, product fix issue, rerun을 cycle로 관리합니다.
---

# Terminal-Bench Loop

Terminal-Bench 문제 하나를 Paperclip을 통해 passing smoke까지 반복하는 운영 skill입니다. explicit issue topology, bounded run, board-gated product fix, worktree continuity를 유지합니다.

이 skill은 operational + diagnostic입니다. 직접 code change를 승인하지 않습니다. product fix는 board confirmation 이후 별도 implementation child issue로 생성합니다.

## 사용할 때

- “Terminal-Bench를 loop로 돌려라”
- “fix-git을 Paperclip으로 통과할 때까지 반복해라”
- 특정 Terminal-Bench task와 bounded iteration 요청
- 기존 loop issue에 대해 다음 iteration, diagnosis, rerun 요청

## 사용하지 않을 때

- `paperclip-bench` 자체 구현 변경
- benchmark ranking 제출용 full-suite run
- Terminal-Bench가 아닌 일반 product bug

## 불변식

1. productive work는 계속되어야 합니다.
2. 진짜 blocker만 멈춰야 합니다.
3. infinite loop는 없어야 합니다.

iteration count, wall-clock budget, board gate로 loop를 bounded하게 유지합니다.

## 입력

top-level loop issue에는 source issue, task name, iteration budget, Paperclip App worktree issue, benchmark command, dispatch runner config, artifact root, approval policy를 기록합니다.

## Issue topology

- top-level loop issue
- iteration child issue
- bounded smoke issue
- diagnosis issue
- fix-proposal document + `request_confirmation`
- accepted 후 implementation / QA / CTO review / rerun child

dependency는 prose가 아니라 `blockedByIssueIds`로 연결합니다.
