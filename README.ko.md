<p align="center">
  <sub>
    🇺🇸 <a href="./README.md"><strong>English README</strong></a>
    &middot;
    <a href="https://github.com/paperclipai/paperclip">paperclipai/paperclip</a> 한국어 번역 포크
    &middot;
    <a href="./ATTRIBUTION.md">Attribution</a>
  </sub>
</p>

<p align="center">
  <img src="doc/assets/header.png" alt="Paperclip — runs your business" width="720" />
</p>

<p align="center">
  <a href="#한국어판-실행-source-install"><strong>한국어판 실행</strong></a> &middot;
  <a href="#quickstart-빠른-시작"><strong>빠른 시작</strong></a> &middot;
  <a href="./docs/ko/README.md"><strong>한국어 문서</strong></a> &middot;
  <a href="https://paperclip.ing/docs"><strong>Upstream Docs</strong></a> &middot;
  <a href="https://github.com/paperclipai/paperclip"><strong>GitHub</strong></a> &middot;
  <a href="https://discord.gg/m4HZY7xNG3"><strong>Discord</strong></a> &middot;
  <a href="https://x.com/papercliping"><strong>Twitter</strong></a>
</p>

<p align="center">
  <a href="https://github.com/paperclipai/paperclip/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://github.com/paperclipai/paperclip/stargazers"><img src="https://img.shields.io/github/stars/paperclipai/paperclip?style=flat" alt="Stars" /></a>
  <a href="https://discord.gg/m4HZY7xNG3"><img src="https://img.shields.io/discord/000000000?label=discord" alt="Discord" /></a>
</p>

<br/>

<div align="center">
  <video src="https://github.com/user-attachments/assets/773bdfb2-6d1e-4e30-8c5f-3487d5b70c8f" width="600" controls></video>
</div>

<br/>

## Paperclip이 뭐예요?

# 무인 회사를 굴리는 오픈소스 오케스트레이션

**OpenClaw가 _직원_이라면, Paperclip은 _회사_입니다.**

Paperclip은 AI 에이전트 팀을 조직처럼 운영하는 Node.js 서버 + React UI예요. 직접 가져온 에이전트들에게 목표를 할당하고, 작업과 비용을 하나의 대시보드에서 추적합니다.

겉보기엔 태스크 매니저처럼 생겼지만, 그 아래엔 조직도, 예산, 거버넌스, 목표 정렬, 에이전트 협업 시스템이 들어있어요.

**PR 말고, 사업 목표를 관리하세요.**

|        | 단계        | 예시                                                                  |
| ------ | ----------- | --------------------------------------------------------------------- |
| **01** | 목표 정의   | _"AI 노트 앱 1위 만들고 MRR $1M까지 가기."_                            |
| **02** | 팀 채용     | CEO, CTO, 엔지니어, 디자이너, 마케터 — 어떤 봇이든, 어떤 프로바이더든. |
| **03** | 승인하고 실행 | 전략 검토, 예산 설정, 시작. 대시보드에서 모니터링.                     |

<br/>

> **곧 출시: Clipmart** — 회사 전체를 한 번 클릭으로 다운받아 실행하세요. 미리 만들어진 회사 템플릿(완성된 조직도, 에이전트 설정, 스킬)을 둘러보고 몇 초 안에 본인의 Paperclip 인스턴스로 가져옵니다.

<br/>

<div align="center">
<table>
  <tr>
    <td align="center"><strong>지원<br/>도구</strong></td>
    <td align="center"><img src="doc/assets/logos/openclaw.svg" width="32" alt="OpenClaw" /><br/><sub>OpenClaw</sub></td>
    <td align="center"><img src="doc/assets/logos/claude.svg" width="32" alt="Claude" /><br/><sub>Claude Code</sub></td>
    <td align="center"><img src="doc/assets/logos/codex.svg" width="32" alt="Codex" /><br/><sub>Codex</sub></td>
    <td align="center"><img src="doc/assets/logos/cursor.svg" width="32" alt="Cursor" /><br/><sub>Cursor</sub></td>
    <td align="center"><img src="doc/assets/logos/bash.svg" width="32" alt="Bash" /><br/><sub>Bash</sub></td>
    <td align="center"><img src="doc/assets/logos/http.svg" width="32" alt="HTTP" /><br/><sub>HTTP</sub></td>
  </tr>
</table>

<em>하트비트만 받을 수 있으면, 채용됩니다.</em>

</div>

<br/>

## Paperclip은 이런 분께 맞아요

- ✅ **자율적으로 굴러가는 AI 회사**를 만들고 싶은 분
- ✅ 여러 종류의 에이전트(OpenClaw, Codex, Claude, Cursor)를 **하나의 목표를 향해 조율**하고 싶은 분
- ✅ **Claude Code 터미널 20개**를 동시에 띄워놓고 누가 뭐 하는지 잃어버리는 분
- ✅ 에이전트가 **24/7 자율 실행**되되 필요할 때 감사하고 개입하고 싶은 분
- ✅ **비용을 모니터링**하고 예산을 강제하고 싶은 분
- ✅ 에이전트 관리가 **태스크 매니저 쓰는 느낌**이면 좋겠다는 분
- ✅ 자율 사업체를 **모바일에서 관리**하고 싶은 분

<br/>

## 한국어판 실행 (source install)

이 레포는 `paperclipai/paperclip`의 한국어 번역 포크입니다. 현재 npm의 `paperclipai` 패키지는 upstream 영문판이므로, 한국어 UI와 문서를 보려면 이 레포를 clone해서 source install 방식으로 실행하세요.

> `npx paperclipai ...`는 npm에 올라간 upstream 영문판을 실행합니다. 한국어판을 쓰려면 아래처럼 `pnpm paperclipai ...`를 이 레포 안에서 실행해야 합니다.

### 1. 포크하거나 clone하기

본인 계정에서 수정/배포까지 할 거면 먼저 GitHub에서 이 레포를 fork하세요.

```sh
git clone https://github.com/<your-id>/paperclip-ko.git
cd paperclip-ko
git remote add ko-upstream https://github.com/yong076/paperclip-ko.git
git remote add paperclip-upstream https://github.com/paperclipai/paperclip.git
```

그냥 한국어판을 로컬에서 써보기만 한다면 바로 clone해도 됩니다.

```sh
git clone https://github.com/yong076/paperclip-ko.git
cd paperclip-ko
```

### 2. 설치

```sh
pnpm install
```

필요 조건은 Node.js 20+와 pnpm 9.15+입니다.

### 3. 한국어판 실행

기존 upstream Paperclip과 데이터를 섞지 않으려면 별도 data dir를 쓰는 것을 권장합니다.

```sh
DO_NOT_TRACK=1 PAPERCLIP_TELEMETRY_DISABLED=1 \
  pnpm paperclipai run --data-dir ~/.paperclip-ko
```

브라우저에서 여세요.

```text
http://127.0.0.1:3100/?lng=ko
```

이미 `3100` 포트를 쓰는 Paperclip이 떠 있다면 먼저 종료하세요.

```sh
lsof -ti:3100 | xargs kill
```

### 4. 업데이트

본인 fork를 쓰는 경우:

```sh
git fetch ko-upstream
git merge --ff-only ko-upstream/master
pnpm install
```

직접 clone한 경우:

```sh
git pull --ff-only
pnpm install
```

### npm 배포에 대해

지금은 한국어판을 npm에 따로 배포하지 않습니다. `paperclipai`라는 npm package name은 upstream이 사용 중이고, CLI만 다른 이름으로 올리면 내부 dependency가 upstream 영문판과 섞일 수 있습니다. 공개 배포가 필요해지면 별도 package name 또는 Docker image로 분리하는 것이 안전합니다.

<br/>

## 한국어 문서

- [한국어 문서 허브](./docs/ko/README.md)
- [Paperclip이란?](./docs/ko/start/what-is-paperclip.md)
- [빠른 시작](./docs/ko/start/quickstart.md)
- [핵심 개념](./docs/ko/start/core-concepts.md)
- [아키텍처](./docs/ko/start/architecture.md)
- [보드 운영자 가이드](./docs/ko/guides/board-operator/creating-a-company.md)
- [Paperclip 스킬](./skills/paperclip/SKILL.ko.md)
- [에이전트 생성 스킬](./skills/paperclip-create-agent/SKILL.ko.md)

<br/>

## 기능

<table>
<tr>
<td align="center" width="33%">
<h3>🔌 직접 가져온 에이전트</h3>
어떤 에이전트든, 어떤 런타임이든, 하나의 조직도. 하트비트만 받을 수 있으면 채용됩니다.
</td>
<td align="center" width="33%">
<h3>🎯 목표 정렬</h3>
모든 작업이 회사 미션까지 거슬러 올라가요. 에이전트는 <em>무엇을</em> 해야 하는지뿐 아니라 <em>왜</em> 하는지도 압니다.
</td>
<td align="center" width="33%">
<h3>💓 하트비트</h3>
에이전트는 정해진 주기에 깨어나 작업을 확인하고 행동해요. 위임은 조직도 위아래로 흐릅니다.
</td>
</tr>
<tr>
<td align="center">
<h3>💰 비용 통제</h3>
에이전트별 월 예산. 한도 도달 시 정지. 폭주 비용 없음.
</td>
<td align="center">
<h3>🏢 멀티 컴퍼니</h3>
한 배포에 여러 회사. 데이터 완전 격리. 포트폴리오 전체를 하나의 컨트롤 플레인에서.
</td>
<td align="center">
<h3>🎫 티켓 시스템</h3>
모든 대화 추적. 모든 결정 설명. 전체 도구 호출 추적과 변경 불가능한 감사 로그.
</td>
</tr>
<tr>
<td align="center">
<h3>🛡️ 거버넌스</h3>
당신이 보드입니다. 채용 승인, 전략 오버라이드, 에이전트 일시정지/종료 — 언제든.
</td>
<td align="center">
<h3>📊 조직도</h3>
계층, 직책, 보고 라인. 에이전트마다 상사, 직함, JD가 있습니다.
</td>
<td align="center">
<h3>📱 모바일 대응</h3>
어디에서든 자율 사업체를 모니터링하고 관리하세요.
</td>
</tr>
</table>

<br/>

## Paperclip이 해결하는 문제

| Paperclip 없이                                                                                                       | Paperclip과 함께                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ❌ Claude Code 탭 20개 열어놓고 어떤 게 뭐 하는지 추적 안 됨. 재부팅하면 다 날아감.                                  | ✅ 작업은 티켓 기반, 대화는 스레드로, 세션은 재부팅을 넘어 지속됩니다.                                                  |
| ❌ 봇한테 지금 뭐 하고 있는지 상기시키려고 여러 곳에서 컨텍스트를 수동으로 모음.                                      | ✅ 컨텍스트가 작업 → 프로젝트 → 회사 목표로 흐릅니다. 에이전트는 항상 무엇을, 왜 하는지 압니다.                          |
| ❌ 에이전트 설정 폴더가 엉망이고, 작업 관리·소통·조율을 매번 새로 만드는 중.                                          | ✅ Paperclip은 조직도, 티켓팅, 위임, 거버넌스를 기본 제공해요. 스크립트 더미 말고 회사를 운영하세요.                     |
| ❌ 폭주 루프가 토큰 수백 달러를 태우고, 알기도 전에 쿼터를 다 써버림.                                                 | ✅ 비용 추적이 토큰 예산을 드러내고, 한도 초과 시 에이전트를 throttle. 예산 기반으로 우선순위가 정해집니다.              |
| ❌ 반복 작업(고객 지원, 소셜, 리포트)을 매번 수동으로 시작해야 함.                                                    | ✅ 하트비트가 정해진 주기에 정기 작업을 처리. 매니지먼트가 감독합니다.                                                  |
| ❌ 아이디어가 떠올라도 레포 찾고, Claude Code 띄우고, 탭 켜놓고, 베이비시팅해야 함.                                  | ✅ Paperclip에 작업 추가만 하면 코딩 에이전트가 끝낼 때까지 작업합니다. 매니지먼트가 결과를 검토합니다.                  |

<br/>

## Paperclip이 특별한 이유

Paperclip은 어려운 오케스트레이션 디테일들을 제대로 처리합니다.

|                                   |                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **원자적 실행**                   | 작업 체크아웃과 예산 강제가 원자적이에요. 중복 작업도 없고 폭주 비용도 없습니다.                                  |
| **지속되는 에이전트 상태**        | 에이전트는 하트비트를 넘어 같은 작업 컨텍스트를 이어갑니다. 매번 처음부터 다시 시작하지 않아요.                    |
| **런타임 스킬 주입**              | 에이전트는 Paperclip 워크플로와 프로젝트 컨텍스트를 런타임에 학습할 수 있어요. 재학습 필요 없음.                    |
| **롤백 가능한 거버넌스**          | 승인 게이트 강제, 설정 변경은 리비전 관리, 잘못된 변경은 안전하게 롤백.                                            |
| **목표 인지 실행**                | 작업은 전체 목표 계보를 들고 다녀요. 에이전트는 제목이 아니라 "왜"를 봅니다.                                       |
| **이식 가능한 회사 템플릿**       | 조직, 에이전트, 스킬을 시크릿 스크럽 + 충돌 처리와 함께 export/import.                                             |
| **진짜 멀티 컴퍼니 격리**         | 모든 엔티티가 회사 단위로 스코프됩니다. 한 배포에서 여러 회사를 별개 데이터·감사 로그로 운영.                       |

<br/>

## 내부 구조

Paperclip은 래퍼가 아니라 완전한 컨트롤 플레인입니다. 본인이 직접 만들기 전에 — 이미 다 있다는 걸 알아두세요.

```
┌──────────────────────────────────────────────────────────────┐
│                       PAPERCLIP SERVER                       │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │Identity & │  │  Work &   │  │ Heartbeat │  │Governance │  │
│  │  Access   │  │   Tasks   │  │ Execution │  │& Approvals│  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │ Org Chart │  │Workspaces │  │  Plugins  │  │  Budget   │  │
│  │ & Agents  │  │ & Runtime │  │           │  │ & Costs   │  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │ Routines  │  │ Secrets & │  │ Activity  │  │  Company  │  │
│  │& Schedules│  │  Storage  │  │ & Events  │  │Portability│  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
└──────────────────────────────────────────────────────────────┘
         ▲              ▲              ▲              ▲
   ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐
   │  Claude   │  │   Codex   │  │   CLI     │  │ HTTP/web  │
   │   Code    │  │           │  │  agents   │  │   bots    │
   └───────────┘  └───────────┘  └───────────┘  └───────────┘
```

### 시스템

<table>
<tr>
<td width="50%">

**Identity & Access (인증/접근)** — 두 가지 배포 모드(신뢰된 로컬 또는 인증), 보드 사용자, 에이전트 API 키, 단명 run JWT, 회사 멤버십, 초대 플로우, OpenClaw 온보딩. 모든 변경 요청은 액터까지 추적됩니다.

</td>
<td width="50%">

**Org Chart & Agents (조직도/에이전트)** — 에이전트는 역할, 직함, 보고 라인, 권한, 예산을 가집니다. 어댑터 예시: Claude Code, Codex, Cursor/Gemini/bash 같은 CLI 에이전트, OpenClaw 같은 HTTP/webhook 봇, 외부 어댑터 플러그인. 하트비트만 받을 수 있으면 채용됩니다.

</td>
</tr>
<tr>
<td>

**Work & Task System (작업/태스크)** — 이슈는 회사/프로젝트/목표/부모 링크, 실행 락이 있는 원자적 체크아웃, 1급 블로커 의존성, 코멘트, 문서, 첨부, 작업 결과물, 라벨, 인박스 상태를 가집니다. 중복 작업 없음, 컨텍스트 손실 없음.

</td>
<td>

**Heartbeat Execution (하트비트 실행)** — DB 기반 wakeup 큐(coalescing 포함), 예산 체크, 워크스페이스 해석, 시크릿 주입, 스킬 로딩, 어댑터 호출. 실행은 구조화된 로그, 비용 이벤트, 세션 상태, 감사 트레일을 만듭니다. 고아 실행 자동 복구.

</td>
</tr>
<tr>
<td>

**Workspaces & Runtime (워크스페이스/런타임)** — 프로젝트 워크스페이스, 격리된 실행 워크스페이스(git worktree, operator 브랜치), 런타임 서비스(개발 서버, 프리뷰 URL). 에이전트는 항상 올바른 디렉토리에서 올바른 컨텍스트로 작업합니다.

</td>
<td>

**Governance & Approvals (거버넌스/승인)** — 보드 승인 워크플로, 검토/승인 단계가 있는 실행 정책, 결정 추적, 예산 hard-stop, 에이전트 일시정지/재개/종료, 전체 감사 로깅. 당신이 보드입니다 — 승인 없이는 아무것도 출시되지 않습니다.

</td>
</tr>
<tr>
<td>

**Budget & Cost Control (예산/비용)** — 회사·에이전트·프로젝트·목표·이슈·프로바이더·모델별 토큰/비용 추적. 경고 임계값과 hard stop이 있는 스코프된 예산 정책. 초과 지출 시 에이전트 자동 일시정지 및 큐 작업 취소.

</td>
<td>

**Routines & Schedules (루틴/스케줄)** — cron, webhook, API 트리거가 있는 반복 작업. 동시성 + catch-up 정책. 각 루틴 실행은 추적 가능한 이슈를 만들고 담당 에이전트를 깨웁니다 — 수동 시작 불필요.

</td>
</tr>
<tr>
<td>

**Plugins (플러그인)** — 인스턴스 단위 플러그인 시스템: out-of-process 워커, capability gate가 걸린 호스트 서비스, 잡 스케줄링, 도구 노출, UI 기여. Paperclip을 포크하지 않고 확장하세요.

</td>
<td>

**Secrets & Storage (시크릿/스토리지)** — 인스턴스 + 회사 시크릿, 암호화 로컬 스토리지, 프로바이더 백엔드 객체 스토리지, 첨부, 작업 결과물. 민감 값은 스코프된 실행에서 명시적으로 필요할 때만 프롬프트에 들어갑니다.

</td>
</tr>
<tr>
<td>

**Activity & Events (활동/이벤트)** — 변경 액션, 하트비트 상태 변화, 비용 이벤트, 승인, 코멘트, 작업 결과물이 모두 영속적인 활동으로 기록됩니다. 운영자는 무엇이 왜 일어났는지 감사할 수 있어요.

</td>
<td>

**Company Portability (회사 이식성)** — 조직 전체를 export/import — 에이전트, 스킬, 프로젝트, 루틴, 이슈 — 시크릿 스크럽 + 충돌 처리 포함. 한 배포, 여러 회사, 완전한 데이터 격리.

</td>
</tr>
</table>

<br/>

## Paperclip이 아닌 것

|                                |                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **챗봇 아님.**                 | 에이전트는 직업이 있어요. 채팅 창이 있는 게 아니라.                                                                       |
| **에이전트 프레임워크 아님.**  | 에이전트를 어떻게 만들지 안 알려줍니다. 에이전트로 이루어진 회사를 어떻게 운영할지 알려줍니다.                            |
| **워크플로 빌더 아님.**        | 드래그앤드롭 파이프라인 없습니다. Paperclip은 회사를 모델링합니다 — 조직도, 목표, 예산, 거버넌스로.                       |
| **프롬프트 매니저 아님.**      | 에이전트는 본인 프롬프트, 모델, 런타임을 가져옵니다. Paperclip은 그들이 일하는 조직을 관리합니다.                         |
| **싱글 에이전트 도구 아님.**   | 이건 팀을 위한 거예요. 에이전트가 1개면 Paperclip이 필요 없을 거예요. 20개라면 — 확실히 필요합니다.                        |
| **코드 리뷰 도구 아님.**       | Paperclip은 작업을 오케스트레이션하지 PR을 다루지 않습니다. 본인 리뷰 프로세스를 가져오세요.                              |

<br/>

## Quickstart (빠른 시작)

오픈소스. 셀프 호스팅. Paperclip 계정 필요 없음.

```bash
npx paperclipai onboard --yes
```

이 quickstart 경로는 첫 실행을 가장 빠르게 하기 위해 신뢰된 로컬 loopback 모드를 디폴트로 합니다. 인증/private 모드로 시작하려면 bind preset을 명시하세요.

```bash
npx paperclipai onboard --yes --bind lan
# 또는:
npx paperclipai onboard --yes --bind tailnet
```

이미 Paperclip이 설정되어 있다면, `onboard`를 다시 실행해도 기존 설정이 유지됩니다. `paperclipai configure`로 설정을 편집하세요.

또는 수동으로:

```bash
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
pnpm dev
```

이렇게 하면 API 서버가 `http://localhost:3100`에서 시작됩니다. 임베디드 PostgreSQL 데이터베이스가 자동으로 생성돼요 — 별도 셋업 불필요.

> **요구사항:** Node.js 20+, pnpm 9.15+

<br/>

## FAQ

**전형적인 셋업이 어떻게 생겼나요?**
로컬에서는 단일 Node.js 프로세스가 임베디드 Postgres와 로컬 파일 스토리지를 관리합니다. 프로덕션이라면 본인 Postgres에 연결하고 원하는 방식으로 배포하세요. 프로젝트, 에이전트, 목표를 설정하면 — 나머지는 에이전트가 처리합니다.

1인 창업자라면 Tailscale을 써서 외부에서 Paperclip에 접근할 수 있어요. 나중에 필요하면 Vercel 같은 곳에 배포해도 됩니다.

**여러 회사를 운영할 수 있나요?**
네. 한 배포에 무제한 개수의 회사를 데이터 완전 격리로 운영할 수 있어요.

**Paperclip이 OpenClaw나 Claude Code 같은 에이전트와 어떻게 달라요?**
Paperclip은 그 에이전트들을 _사용_합니다. 에이전트들을 회사로 오케스트레이션해요 — 조직도, 예산, 목표, 거버넌스, 책임을 가진 회사로.

**OpenClaw를 그냥 Asana나 Trello에 연결하지 않고 왜 Paperclip을 써야 해요?**
에이전트 오케스트레이션엔 미묘한 디테일이 있어요 — 누가 작업을 체크아웃했는지 조율, 세션 유지, 비용 모니터링, 거버넌스 수립. Paperclip이 이걸 다 해줍니다.

(Bring-your-own-ticket-system은 로드맵에 있습니다.)

**에이전트가 계속 실행되나요?**
디폴트로 에이전트는 스케줄된 하트비트와 이벤트 트리거(작업 할당, @멘션)에 따라 실행됩니다. OpenClaw 같은 continuous 에이전트도 연결할 수 있어요. 에이전트는 본인이 가져오고 Paperclip이 조율합니다.

<br/>

## 개발

```bash
pnpm dev              # 전체 개발(API + UI, watch 모드)
pnpm dev:once         # 파일 watch 없이 전체 개발
pnpm dev:server       # 서버만
pnpm build            # 전체 빌드
pnpm typecheck        # 타입 체크
pnpm test             # 가벼운 디폴트 테스트(Vitest만)
pnpm test:watch       # Vitest watch 모드
pnpm test:e2e         # Playwright 브라우저 스위트
pnpm db:generate      # DB 마이그레이션 생성
pnpm db:migrate       # 마이그레이션 적용
```

`pnpm test`는 Playwright를 실행하지 않습니다. 브라우저 스위트는 분리되어 있고 보통 해당 플로우 작업 시나 CI에서만 실행해요.

전체 개발 가이드는 [doc/DEVELOPING.md](doc/DEVELOPING.md)를 참고하세요.

<br/>

## 로드맵

- ✅ 플러그인 시스템 (예: 지식 베이스, 커스텀 트레이싱, 큐 등)
- ✅ OpenClaw / claw 스타일 에이전트 직원
- ✅ companies.sh — 조직 전체 import/export
- ✅ Easy AGENTS.md 설정
- ✅ 스킬 매니저
- ✅ 스케줄된 루틴
- ✅ 개선된 예산 관리
- ✅ 에이전트 리뷰 및 승인
- ✅ 다중 사용자 지원
- ⚪ 클라우드 / 샌드박스 에이전트 (예: Cursor / e2b)
- ⚪ Artifacts & Work Products
- ⚪ Memory / Knowledge
- ⚪ Enforced Outcomes
- ⚪ MAXIMIZER MODE
- ⚪ Deep Planning
- ⚪ Work Queues
- ⚪ Self-Organization
- ⚪ Automatic Organizational Learning
- ⚪ CEO Chat
- ⚪ 클라우드 배포
- ⚪ 데스크톱 앱

이건 짧은 로드맵 미리보기입니다. 전체 로드맵은 [ROADMAP.md](ROADMAP.md)를 보세요.

<br/>

## 커뮤니티 & 플러그인

플러그인과 더 많은 정보: [awesome-paperclip](https://github.com/gsxdsm/awesome-paperclip)

## 텔레메트리

Paperclip은 익명 사용 데이터를 수집해요 — 제품을 어떻게 쓰는지 이해하고 개선하기 위해. 개인 정보, 이슈 내용, 프롬프트, 파일 경로, 시크릿은 절대 수집하지 않습니다. 비공개 레포 참조는 install별 솔트로 해시되어 전송돼요.

텔레메트리는 **디폴트로 활성화**되어 있고, 아래 방법 중 하나로 끌 수 있습니다.

| 방법                  | 어떻게                                                          |
| --------------------- | --------------------------------------------------------------- |
| 환경 변수             | `PAPERCLIP_TELEMETRY_DISABLED=1`                                |
| 표준 컨벤션           | `DO_NOT_TRACK=1`                                                |
| CI 환경               | `CI=true`이면 자동으로 비활성화                                 |
| 설정 파일             | Paperclip 설정에서 `telemetry.enabled: false`                   |

## 기여

기여를 환영해요. 자세한 내용은 [contributing guide](CONTRIBUTING.md)를 참고하세요.

**한국어 번역 관련 기여**는 이 포크 레포(`yong076/paperclip-ko`)에서 받습니다. [`ATTRIBUTION.md`](./ATTRIBUTION.md)를 보세요.

<br/>

## 커뮤니티

- [Discord](https://discord.gg/m4HZY7xNG3) — 커뮤니티 참여
- [Twitter / X](https://x.com/papercliping) — 업데이트와 공지
- [GitHub Issues](https://github.com/paperclipai/paperclip/issues) — 버그/기능 요청 (upstream)
- [GitHub Discussions](https://github.com/paperclipai/paperclip/discussions) — 아이디어/RFC

<br/>

## 라이선스

MIT &copy; 2026 Paperclip

이 한국어 번역 포크는 원본 MIT 라이선스를 그대로 보존합니다. 자세한 내용은 [LICENSE](./LICENSE)와 [ATTRIBUTION.md](./ATTRIBUTION.md)를 보세요.

## Star History

[![Star History Chart](https://api.star-history.com/image?repos=paperclipai/paperclip&type=date&legend=top-left)](https://www.star-history.com/?repos=paperclipai%2Fpaperclip&type=date&legend=top-left)

<br/>

---

<p align="center">
  <img src="doc/assets/footer.jpg" alt="" width="720" />
</p>

<p align="center">
  <sub>MIT 오픈소스. 에이전트를 베이비시팅하지 말고 회사를 운영하고 싶은 사람들을 위한 도구.</sub>
</p>
