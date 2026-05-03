---
title: Execution Workspaces And Runtime Services
summary: 프로젝트 런타임 설정, 실행 워크스페이스, 이슈 실행 모델
---

# Execution Workspaces And Runtime Services

Paperclip은 프로젝트 실행을 **workspace command** 모델로 다룹니다.

- `Services`는 계속 떠 있어야 하는 장기 실행 명령입니다.
- `Jobs`는 한 번 실행하고 종료되는 명령입니다.
- raw runtime JSON도 고급 설정으로 남아 있지만, 기본 사고방식은 services/jobs입니다.

## 프로젝트 런타임 설정

프로젝트 workspace에는 해당 프로젝트를 어떻게 실행할지 정의할 수 있습니다.

- 프로젝트 workspace의 runtime config는 service와 job 목록을 설명합니다.
- 하위 execution workspace가 기본값으로 상속할 수 있습니다.
- config를 정의한다고 해서 자동으로 실행되지는 않습니다.

## 수동 런타임 제어

서비스와 job은 UI에서 직접 시작하고 멈춥니다.

- 프로젝트 workspace 서비스는 프로젝트 workspace UI에서 제어합니다.
- execution workspace 서비스는 해당 execution workspace UI에서 제어합니다.
- 이슈 실행이 시작된다고 Paperclip이 자동으로 서비스를 켜거나 끄지 않습니다.
- 서버 재시작 후에도 서비스를 자동 재시작하지 않습니다.

## Execution workspace 상속

Execution workspace는 코드와 런타임 상태를 프로젝트 기본 workspace에서 분리합니다.

- isolated execution workspace는 자체 checkout path, branch, runtime instance를 가집니다.
- runtime config는 연결된 project workspace에서 상속할 수 있습니다.
- 각 execution workspace는 자기만의 override를 가질 수 있습니다.
- 상속되는 것은 “어떤 명령이 존재하고 어떻게 실행하는가”이지, 실행 중인 프로세스 자체가 아닙니다.

## 이슈와 workspace

- 이슈는 isolated workspace를 새로 만들 수 있습니다.
- 기존 execution workspace를 재사용할 수도 있습니다.
- 여러 이슈가 의도적으로 하나의 execution workspace를 공유할 수 있습니다.
- 이슈 assignment나 heartbeat 실행은 workspace service를 자동 제어하지 않습니다.

## 운영 기준

Execution workspace는 사람이 닫기 전까지 유지됩니다. workspace를 닫으면 허용 가능한 경우 runtime service를 멈추고 workspace artifact를 정리합니다. 공유 workspace나 프로젝트 기본 checkout은 더 보수적으로 정리합니다.
