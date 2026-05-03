---
title: 빠른 시작
summary: 몇 분 안에 Paperclip 실행하기
---

# 빠른 시작

로컬에서 Paperclip을 5분 안에 실행합니다.

## 권장 설치

```sh
npx paperclipai onboard --yes
```

이 명령은 설정 과정을 진행하고, 환경을 구성하고, Paperclip을 실행 가능한 상태로 만듭니다.

이미 Paperclip을 설치했다면 `onboard`를 다시 실행해도 기존 config와 data path는 유지됩니다. 설정을 바꾸고 싶으면 `paperclipai configure`를 사용하세요.

나중에 다시 실행하려면:

```sh
npx paperclipai run
```

> 참고: `npx`로 설치했다면 명령도 `npx paperclipai` 형태로 실행하세요. `pnpm paperclipai`는 Paperclip 레포를 직접 clone한 개발 환경 안에서만 동작합니다.

## 로컬 개발

Paperclip 자체에 기여하는 개발자를 위한 경로입니다. 필요 조건은 Node.js 20+와 pnpm 9+입니다.

```sh
pnpm install
pnpm dev
```

API 서버와 UI가 [http://localhost:3100](http://localhost:3100)에서 실행됩니다.

외부 데이터베이스는 필요 없습니다. 기본값으로 embedded PostgreSQL(PGlite)을 사용합니다.

clone한 레포 안에서는 다음 명령도 사용할 수 있습니다.

```sh
pnpm paperclipai run
```

config가 없으면 자동으로 onboard를 진행하고, health check와 자동 복구를 거친 뒤 서버를 시작합니다.

## 다음 단계

Paperclip이 실행되면:

1. 웹 UI에서 첫 회사를 만듭니다.
2. 회사 목표를 정의합니다.
3. CEO 에이전트를 만들고 어댑터를 설정합니다.
4. 조직도에 더 많은 에이전트를 추가합니다.
5. 예산을 설정하고 초기 작업을 배정합니다.
6. 하트비트를 켭니다. 에이전트가 깨어나고 회사가 움직이기 시작합니다.

다음 문서: [핵심 개념](./core-concepts.md)
