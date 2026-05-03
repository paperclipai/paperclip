---
title: Gemini Local
summary: Gemini CLI local adapter 설정
---

# Gemini Local

`gemini_local` adapter는 Google Gemini CLI를 로컬에서 실행합니다. `--resume` 기반 session persistence, skills injection, `stream-json` output parsing을 지원합니다.

## Prerequisites

- Gemini CLI 설치 (`gemini` command 사용 가능)
- `GEMINI_API_KEY` 또는 `GOOGLE_API_KEY` 설정, 또는 local Gemini CLI auth 구성

## 설정 필드

| Field | Required | 설명 |
| --- | --- | --- |
| `cwd` | Yes | agent process working directory |
| `model` | No | Gemini model. 기본값 `auto` |
| `promptTemplate` | No | 모든 run에 사용할 prompt |
| `instructionsFilePath` | No | prompt 앞에 붙일 Markdown instruction file |
| `env` | No | environment variables. secret refs 지원 |
| `timeoutSec` | No | process timeout |
| `graceSec` | No | force kill 전 grace period |
| `yolo` | No | unattended operation을 위해 `--approval-mode yolo` 전달 |

## Session persistence

adapter는 Gemini session ID를 저장하고 다음 heartbeat에서 `--resume`으로 복원합니다. working directory가 바뀌면 fresh session을 시작하고, unknown session error가 발생하면 fresh session으로 자동 재시도합니다.

## Skills injection

Paperclip skills를 `~/.gemini/skills`에 symlink합니다. 기존 user skill은 overwrite하지 않습니다.

## Environment test

UI의 **Test Environment**는 Gemini CLI 접근성, working directory, API key/auth hint, live hello probe 실행 가능 여부를 확인합니다.
