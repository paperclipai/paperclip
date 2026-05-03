---
title: 빠른 시작
summary: 몇 분 안에 Paperclip 실행하기
---

# 빠른 시작

로컬에서 Paperclip을 실행합니다. 한국어 번역 포크는 npm에 별도 배포할 계획이 없습니다. 한국어 UI를 보려면 `paperclip-ko` 레포를 clone/fork해서 source install 방식으로 실행하세요.

## 한국어판 권장 실행

```sh
git clone https://github.com/yong076/paperclip-ko.git
cd paperclip-ko
pnpm install
DO_NOT_TRACK=1 PAPERCLIP_TELEMETRY_DISABLED=1 \
  pnpm paperclipai run --data-dir ~/.paperclip-ko
```

브라우저에서 엽니다.

```text
http://127.0.0.1:3100/?lng=ko
```

기존 Paperclip이 `3100` 포트를 쓰고 있다면 먼저 종료합니다.

```sh
lsof -ti:3100 | xargs kill
```

## 본인 fork로 운영하기

계속 수정하거나 배포할 예정이면 GitHub에서 `yong076/paperclip-ko`를 본인 계정으로 fork한 뒤 clone하세요.

```sh
git clone https://github.com/<your-id>/paperclip-ko.git
cd paperclip-ko
git remote add ko-upstream https://github.com/yong076/paperclip-ko.git
git remote add paperclip-upstream https://github.com/paperclipai/paperclip.git
pnpm install
```

한국어 포크 업데이트:

```sh
git fetch ko-upstream
git merge --ff-only ko-upstream/master
pnpm install
```

## npm quickstart와 차이

upstream 영문판을 가장 빠르게 실행하려면 다음 명령을 쓸 수 있습니다.

```sh
npx paperclipai onboard --yes
```

하지만 이 명령은 npm에 올라간 upstream `paperclipai` package를 실행합니다. 한국어 번역 포크의 UI와 문서를 보려면 `npx`가 아니라 clone한 레포 안에서 `pnpm paperclipai ...`를 실행해야 합니다.

이 포크는 npm package를 새로 배포하기보다, 번역과 i18n 방향을 검증한 뒤 upstream `paperclipai/paperclip`에 PR을 보내는 것을 목표로 합니다.

이미 Paperclip을 설치했다면 `onboard`를 다시 실행해도 기존 config와 data path는 유지됩니다. 설정을 바꾸고 싶으면 `paperclipai configure`를 사용하세요.

## 로컬 개발

Paperclip 자체에 기여하는 개발자를 위한 경로입니다. 필요 조건은 Node.js 20+와 pnpm 9.15+입니다.

clone한 레포 안에서는 다음 명령도 사용할 수 있습니다.

```sh
pnpm dev
```

API 서버와 UI가 [http://localhost:3100](http://localhost:3100)에서 실행됩니다. 외부 데이터베이스는 필요 없습니다. 기본값으로 embedded PostgreSQL(PGlite)을 사용합니다.

## 다음 단계

Paperclip이 실행되면:

1. 웹 UI에서 첫 회사를 만듭니다.
2. 회사 목표를 정의합니다.
3. CEO 에이전트를 만들고 어댑터를 설정합니다.
4. 조직도에 더 많은 에이전트를 추가합니다.
5. 예산을 설정하고 초기 작업을 배정합니다.
6. 하트비트를 켭니다. 에이전트가 깨어나고 회사가 움직이기 시작합니다.

다음 문서: [핵심 개념](./core-concepts.md)
