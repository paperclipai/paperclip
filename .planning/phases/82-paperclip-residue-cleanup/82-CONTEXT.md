# Phase 82 Context: Paperclip Residue Cleanup

## Overview
Phase 82는 v3.3의 최종 단계 중 하나로, RealTycoon2 앱의 product-facing 영역에서 레거시 Paperclip의 흔적(잔재, Residue)을 정리하고 완전히 RT2 네이티브한 환경으로 분리/정렬하는 것을 목표로 합니다. 

## Requirements Target
- **CLEANUP-01**: RT2 product-facing surface에서 Paperclip-derived control plane naming이 완전히 제거되었다.
- **CLEANUP-02**: RT2 schema/service/API projection이 RT2-controlled contract만 사용하고 upstream Paperclip asset을 직접 참조하지 않는다.
- **CLEANUP-03**: UI surface에서 `@paperclipai/*` package 참조가 compatibility layer로만 존재하고 product-facing이 아니다.

## Key Focus Areas
1. **UI Text & Branding**: 사용자에게 보여지는 화면(로고, 헤더, 알림, 에러 메시지 등)에 노출된 'Paperclip' 단어, 혹은 레거시 네이밍 교체
2. **Schema / API Contracts**: RT2 내부 모듈(UI, API)이 Paperclip의 raw 스키마/함수를 직접 가져다 쓰는 부분을, RT2 어댑터나 Facade(contract) 계층으로 래핑
3. **Package Usage**: `@paperclip-ui/*`나 `@paperclipai/*`와 같은 패키지를 그대로 컴포넌트에 노출하기보다는 RT2 디자인 시스템 계층에서 한 번 래핑해서 사용하도록 변경

## Expected Tasks
- 전체 코드베이스 내 UI 노출 텍스트 "Paperclip" 검색 및 RT2/iSens 관련 용어로 변경.
- RT2 API / 서비스 내 `packages/db` 또는 `server` 내부의 Paperclip asset 직접 참조를 검토 및 RT2 contract 기반으로 리팩토링.
- 프론트엔드(`ui/`)의 컴포넌트들에서 `@paperclipai` 패키지 import가 RT2 도메인 맥락(RT2-specific hook/component)을 거치도록 추상화.
