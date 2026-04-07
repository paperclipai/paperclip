# Paperclip i18n 아키텍처 설계서

## 1. 요약

Paperclip에 다국어(i18n)를 적용하기 위한 최선의 방법을 Claude + Codex 교차검증(6단계)으로 도출했다.

**결론: Core i18n (Approach A)를 지금 적용하고, 추후 Plugin SDK 성숙 시 단계적으로 Plugin 확장(A→C 마이그레이션)**

**권고 실행 경로:**
```
Phase A (완료) → Phase C-1 (단순화, ~15시간) → Phase C-2 (전체 전환, ~50시간)
```

**총 예상 공수: ~65시간 (Phase A 제외)**

---

## 2. 검토한 3가지 접근법

### Approach A: Core-Only (현재 PR #3046)

Core에 i18next를 직접 도입하고, 모든 UI 문자열을 `t()` 호출로 감싼다.

```
ui/src/i18n/
├── index.ts          # i18next 초기화 (singleton)
├── formatters.ts     # locale-aware 포맷터
├── types.ts          # TypeScript 타입 확장
└── locales/
    ├── en/           # 영어 (기본)
    │   ├── common.json
    │   ├── agents.json
    │   └── ... (15 namespaces)
    └── ko/           # 한국어
        ├── common.json
        ├── agents.json
        └── ... (15 namespaces)
```

| 평가 항목 | 점수 | 근거 |
|---|---|---|
| 실현 가능성 | ★★★★★ | 이미 구현 완료 (PR #3046) |
| 개발 공수 | 2~5일 | 현재 브랜치 기준 잔여 작업 |
| 유지보수성 | ★★★★☆ | Core 변경 시 번역 키도 함께 관리 필요 |
| upstream 수용 가능성 | ★★★★★ | Core 기능으로 자연스러움 |
| 커뮤니티 확장성 | ★★★☆☆ | 새 언어 추가 시 Core PR 필요 |
| 리스크 | 낮음 | 검증된 i18next 라이브러리 |

**판정: ✅ RECOMMENDED (Claude + Codex 합의)**

---

### Approach B: Pure Plugin

Core를 전혀 수정하지 않고 Plugin SDK만으로 다국어를 구현한다.

| 평가 항목 | 점수 | 근거 |
|---|---|---|
| 실현 가능성 | ★☆☆☆☆ | Plugin SDK에 i18n hook 없음 |
| 개발 공수 | 15~25일 | 새로운 Core/Plugin 인프라 전체 구축 필요 |
| 유지보수성 | — | 구현 불가로 평가 불가 |
| upstream 수용 가능성 | ★★☆☆☆ | Plugin spec 위반 (additive only, no core override) |
| 커뮤니티 확장성 | — | 구현 불가 |
| 리스크 | 매우 높음 | 미성숙 SDK 확장 필요 |

**현재 SDK에 없는 것:**
- `registerLocale()` API 없음
- catalog merge hook 없음
- Core UI 텍스트 override 메커니즘 없음
- `usePluginTranslation()` hook 없음
- Manifest에 locale 선언 필드 없음
- Plugin에서 Settings > General에 언어 선택기 추가 불가

**Plugin Spec 명시:**
> "plugins are additive and may not override core routes/actions"

**판정: ❌ NOT VIABLE (Claude + Codex 합의)**

---

### Approach C: Hybrid (Core 인프라 + Plugin 언어팩)

Phase 1에서 Core i18n 인프라를 구축하고, Phase 2에서 Plugin SDK를 확장하여 언어팩을 Plugin으로 분리한다.

**판정: ⚠️ VIABLE — 장기적으로 가능하지만 단계적 접근 필요 (Claude + Codex 합의)**

---

## 3. i18n 컨벤션

### 3.1 번역 키 네이밍 규칙

```
{namespace}:{category}.{element}
```

| 규칙 | 예시 | 설명 |
|---|---|---|
| 네임스페이스별 분리 | `issues:list.empty` | 페이지/기능 단위로 namespace 분리 |
| 계층적 카테고리 | `agents:tab.configuration` | 기능 영역.UI 요소 |
| 동사형 액션 | `common:button.save` | 버튼/액션은 동사형 |
| 상태 표시 | `agents:status.running` | 상태값은 status 접두사 |
| 에러/경고 | `issues:error.createFailed` | 에러는 error 접두사 |
| toast 메시지 | `settings:toast.saved` | toast는 toast 접두사 |
| placeholder | `issues:placeholder.searchIssues` | 입력 힌트는 placeholder 접두사 |
| 확인 다이얼로그 | `agents:confirm.deleteAgent` | 확인 팝업은 confirm 접두사 |

### 3.2 JSON 파일 구조 규칙

```json
// keySeparator: false → 모든 키는 FLAT 문자열
// 올바른 예:
{
  "list.empty": "No items found",
  "list.loading": "Loading...",
  "button.save": "Save",
  "button.cancel": "Cancel"
}

// 잘못된 예 (중첩 객체 금지):
{
  "list": {
    "empty": "No items found"
  }
}
```

### 3.3 컴포넌트 적용 규칙

```typescript
// 규칙 1: React 컴포넌트 — useTranslation() hook 사용
function MyComponent() {
  const { t } = useTranslation("namespace");
  return <div>{t("key", { defaultValue: "English text" })}</div>;
}

// 규칙 2: 모든 t() 호출에 defaultValue 필수
t("key", { defaultValue: "Fallback English" })  // ✅
t("key")                                         // ❌ defaultValue 없음

// 규칙 3: early return이 있는 컴포넌트 — i18n.t() 싱글톤 사용
function ConditionalComponent({ data }) {
  if (!data) return null;  // early return
  // useTranslation()을 여기에 넣으면 hook 순서 위반
  return <div>{i18n.t("ns:key", { defaultValue: "Text" })}</div>;
}

// 규칙 4: useMemo/useEffect/useCallback 의존성에 t 금지
const label = useMemo(() => {
  return i18n.t("ns:key", { defaultValue: "Text" });  // ✅ i18n.t() 사용
}, []);  // t를 deps에 넣지 않음

// 규칙 5: 비컴포넌트 함수 — i18n.t() 사용
function formatLabel(status: string): string {
  return i18n.t(`status.${status}`, { defaultValue: status });
}

// 규칙 6: 보간(interpolation)
t("greeting", { defaultValue: "Hello {{name}}", name: userName })
// JSON: "greeting": "Hello {{name}}"
// KO:  "greeting": "안녕하세요 {{name}}"

// 규칙 7: 조건부 텍스트
{isActive
  ? t("status.active", { defaultValue: "Active" })
  : t("status.inactive", { defaultValue: "Inactive" })}
```

### 3.4 네임스페이스 할당 규칙

| 네임스페이스 | 대상 | 파일 위치 |
|---|---|---|
| `common` | 공통 UI (버튼, 레이블, 레이아웃) | `locales/{lang}/common.json` |
| `agents` | 에이전트 관리 | `locales/{lang}/agents.json` |
| `issues` | 이슈 관리, 채팅, 필터, 속성 | `locales/{lang}/issues.json` |
| `costs` | 비용, 예산, 구독 | `locales/{lang}/costs.json` |
| `inbox` | 받은함 | `locales/{lang}/inbox.json` |
| `dashboard` | 대시보드 | `locales/{lang}/dashboard.json` |
| `projects` | 프로젝트 관리 | `locales/{lang}/projects.json` |
| `goals` | 목표 관리 | `locales/{lang}/goals.json` |
| `approvals` | 승인 워크플로우 | `locales/{lang}/approvals.json` |
| `routines` | 루틴 스케줄링 | `locales/{lang}/routines.json` |
| `settings` | 인스턴스/회사 설정, 어댑터 | `locales/{lang}/settings.json` |
| `onboarding` | 온보딩 위저드 | `locales/{lang}/onboarding.json` |
| `skills` | 스킬 관리 | `locales/{lang}/skills.json` |
| `workspaces` | 실행 워크스페이스 | `locales/{lang}/workspaces.json` |
| `plugins` | 플러그인 설정 | `locales/{lang}/plugins.json` |

### 3.5 Plugin 네임스페이스 규칙 (Phase C)

```
// Plugin 전용 네임스페이스: dot(.) 구분자 사용 (: 충돌 회피)
plugin.{pluginKey}.{namespace}

// 예시:
plugin.linear.messages     // Linear 플러그인의 messages 네임스페이스
plugin.github.notifications // GitHub 플러그인의 notifications

// ❌ 잘못된 예 (i18next nsSeparator ':' 충돌):
plugin-linear:messages     // ':' 가 namespace separator로 해석됨
```

### 3.6 번역 품질 규칙

| 규칙 | 설명 |
|---|---|
| EN 키 = 소스 오브 트루스 | 영어 defaultValue가 원본. KO JSON은 번역본 |
| 모든 EN 키에 KO 키 매칭 | EN에 있는 키는 KO에도 반드시 존재 |
| 기술 용어 유지 | Agent, Heartbeat, Plugin, Adapter 등은 영어 유지 |
| 자연스러운 한국어 | 직역 금지. 맥락에 맞는 자연스러운 표현 |
| 존칭 통일 | "~하세요" 체 통일 (예: "저장하세요", "선택하세요") |
| 길이 고려 | 한국어가 영어보다 길어질 수 있으므로 UI 깨짐 주의 |
| 복수형 불필요 | 한국어는 복수형 구분 없음. `_one`/`_other` 사용 안 함 |

### 3.7 새 문자열 추가 체크리스트

새 UI 문자열을 추가할 때:

- [ ] `t("key", { defaultValue: "English text" })` 형태로 코드에 추가
- [ ] `locales/en/{namespace}.json`에 키 추가
- [ ] `locales/ko/{namespace}.json`에 한국어 번역 추가
- [ ] JSON 유효성 확인 (`python3 -c "import json; json.load(open('file'))"`)
- [ ] EN과 KO 키 수 일치 확인
- [ ] useMemo/useEffect/useCallback 의존성에 t 미포함 확인
- [ ] typecheck 통과 확인

### 3.8 upstream rebase 시 i18n 유지 체크리스트

rebase 충돌 해결 후:

- [ ] upstream의 코드 구조/로직 변경 유지
- [ ] `useTranslation` import 재적용
- [ ] `t()` 호출 재적용
- [ ] upstream이 제거한 코드의 i18n도 함께 제거
- [ ] upstream이 추가한 새 영어 문자열에 t() 래핑
- [ ] 새 키를 EN/KO JSON에 추가
- [ ] `grep -rn "<<<<<<" ui/src/` 로 충돌 마커 잔존 확인
- [ ] `grep -rn "\], \[.*\bt\b" ui/src/` 로 의존성 배열 오염 확인
- [ ] typecheck + unit test + 브라우저 콘솔 검증

---

## 4. 최종 권고안: 3단계 실행 경로

### Phase A: Core i18n (완료)

```
PR #3046 머지
→ Core에 i18next 인프라 + EN/KO 번역
→ 모든 UI 문자열 t() 래핑 완료 (148 파일, ~2,479 키)
→ Settings > General에 언어 선택기
→ defaultValue 폴백으로 번역 누락 시 영어 표시
```

### Phase C-1: 단순화된 Plugin i18n 확장 (~15시간)

**목표: Plugin이 자기 UI의 번역을 관리할 수 있게 한다. Core EN+KO는 유지.**

```
1. usePluginTranslation() bridge hook 추가
2. Plugin custom-namespace 로딩 (plugin 자체 UI 번역만)
3. Bridge registry에 i18n 인터페이스 추가
4. Core EN+KO는 그대로 유지 (제거하지 않음)
```

| 작업 | 예상 공수 | 수정 파일 |
|---|---|---|
| Bridge에 i18n 인터페이스 추가 | 2시간 | `ui/src/plugins/bridge-init.ts` |
| `usePluginTranslation()` hook 구현 | 3시간 | `packages/plugins/sdk/src/ui/hooks.ts`, `index.ts` |
| Plugin bare-specifier shim 업데이트 | 1시간 | `ui/src/plugins/slots.tsx` |
| Plugin custom-namespace 로딩 | 4시간 | `ui/src/i18n/index.ts`, `server/src/routes/plugins.ts` |
| Manifest `i18n` 필드 추가 (선택적) | 3시간 | `packages/shared/src/types/plugin.ts`, `validators/plugin.ts` |
| 테스트 + 예제 | 2시간 | — |

**C-1 Locale Discovery 메커니즘 (Codex 지적 반영):**
- 기존 `/_plugins/:pluginId/ui/*` 경로를 활용하여 convention-based discovery
- Plugin UI 번들 내 `locales/{lang}/{ns}.json` 경로 규칙
- Manifest `i18n` 필드는 선택적 — 없으면 convention으로 탐색
- 별도 서버 API 불필요 (기존 static serving 활용)

**pluginKey 전달 (Codex 지적 반영):**
- `usePluginTranslation()`은 명시적 namespace 인자를 필수로 받음
- pluginKey 자동 추론 불필요 → PluginBridgeContext 변경 없음
- 향후 C-2에서 자동 추론이 필요하면 그때 `pluginKey` 추가

**이 단계에서 하지 않는 것:**
- Core에서 KO 제거 ❌
- Locale-only 플러그인 ❌
- 동적 언어 레지스트리 ❌
- Core 네임스페이스 merge ❌

### Phase C-2: 전체 Plugin 언어팩 전환 (~50시간)

**목표: KO를 Core에서 Plugin으로 이동. 커뮤니티가 새 언어를 Plugin으로 추가 가능.**

**C-2를 내부적으로 2단계로 분리 (Codex 권고):**

#### C-2a: 인프라 구축 (~30시간)

```
1. Locale-only 플러그인 개념 도입 (worker 선택적, capabilities 0개 허용)
2. 서버 Locale API: GET /api/plugins/locales/:language
3. 서버 Languages API: GET /api/plugins/languages (coverage 메타데이터 포함)
4. loadLanguage() 서버 fetch 전환
5. 첫 렌더 preload (saved language 로드 완료까지 대기)
6. i18n 정리 로직 (plugin uninstall 시 해당 locale 제거)
7. Locale 캐시/버전 전략 (?v= 또는 content hash)
8. PluginBridgeContext에 pluginKey 추가
```

| 작업 | 예상 공수 |
|---|---|
| Locale-only 플러그인 (types, validators, loader, lifecycle) | 8시간 |
| 서버 Locale API + Languages API | 6시간 |
| loadLanguage() fetch 전환 + preload | 5시간 |
| i18n 정리 로직 (plugin install/update/uninstall) | 4시간 |
| Locale 캐시/버전 전략 | 3시간 |
| PluginBridgeContext에 pluginKey 추가 | 2시간 |
| 테스트 | 2시간 |

#### C-2b: KO 이전 (~20시간)

**전제: C-2a 인프라가 완료되고 안정화된 후에만 진행**

```
1. paperclip-plugin-lang-ko 패키지 생성
2. KO JSON 15개 복사 + 검증
3. Plugin 설치 + 동작 검증
4. 이중 소스 기간 (Core + Plugin 동시 제공, 1 릴리스)
5. Core에서 KO 제거
6. 동적 언어 레지스트리 (LanguageSelector 동적화)
7. 문서화 (LOCALE_PLUGINS.md)
```

| 작업 | 예상 공수 |
|---|---|
| KO Plugin 패키지 생성 | 4시간 |
| 이중 소스 테스트 | 4시간 |
| Core KO 제거 + 전환 | 3시간 |
| LanguageSelector 동적화 | 3시간 |
| 문서화 | 2시간 |
| 통합 테스트 + 안정화 | 4시간 |

**마이그레이션 전제 조건:**
- Plugin SDK가 V1 이후 성숙 단계 도달
- Phase C-2a 인프라 완료 및 안정화
- Core 영어 키가 안정적으로 유지됨

---

## 5. Codex 교차검증 블로커 및 해결 방안

### 블로커 1: Locale-only 플러그인 불가

**현상:**
- `capabilities` 최소 1개 필수 (`validators/plugin.ts:399`)
- `entrypoints.worker` 필수 (`types/plugin.ts:229`)
- 활성화 시 항상 worker 시작 (`plugin-loader.ts:1727`)
- lifecycle에 worker=plugin 가정 내재 (`plugin-lifecycle.ts:23, :711`)

**해결 (Phase C-2a):**
- `capabilities` `.min(1)` 완화: `locales`가 있으면 0개 허용
- `entrypoints.worker` 선택적: `locales`만 있으면 worker 불필요
- plugin-loader에서 worker entrypoint 해석 시 locales-only 분기 추가
- lifecycle에서 locale-only plugin은 `ready` 상태 진입 시 worker 시작 생략

### 블로커 2: `:` 네임스페이스 충돌

**현상:**
- `keySeparator: false`이지만 `nsSeparator`는 기본값 `:` (`i18n/index.ts:96`)
- `pluginKey:ns` 형태가 i18next namespace separator와 충돌

**해결:**
- Plugin 네임스페이스에 `.`(dot) 사용: `plugin.linear.messages`
- i18next 설정 변경 없음 (기존 코드 영향 회피)
- 컨벤션 문서에 명시 (섹션 3.5)

### 블로커 3: 첫 렌더 preload 누락

**현상:**
- `LanguageSelector`가 동기적 `changeLanguage()` 호출 (`LanguageSelector.tsx:19`)
- `loadLanguage()`는 별도 비동기 (`i18n/index.ts:103`)
- 새로고침 시 saved language의 locale fetch 완료 전 EN 표시 (FOUC)

**해결 (Phase C-2a):**
```typescript
// 앱 초기화 시 (main.tsx)
const savedLang = localStorage.getItem("paperclip.language") ?? "en";
if (savedLang !== "en") {
  await loadLanguage(savedLang);  // 로드 완료까지 대기
}
i18n.changeLanguage(savedLang);
// 이후 React render
```

### 블로커 4: Worker 건강 = 번역 가용성 결합

**현상:**
- Plugin static serving이 `ready` 플러그인만 서빙 (`plugin-ui-static.ts:275`)
- Worker crash 시 plugin이 `error` 상태 → locale 서빙 중단

**해결 (Phase C-2a):**
- Locale 서빙을 worker 상태와 분리
- Locale은 정적 자원 → `enabled` 상태이면 서빙 (worker 불필요)
- Locale API를 `/api/plugins/locales/` 하위에 배치 (인증 포함, Codex 권고)

### 블로커 5: Plugin uninstall 시 i18n 정리 없음 (Codex 추가 발견)

**현상:**
- `i18n.addResourceBundle()`만 있고 제거 경로 없음
- Plugin uninstall 시 해당 언어의 번역이 메모리에 잔존

**해결 (Phase C-2a):**
```typescript
// Plugin uninstall/disable 이벤트 핸들러
function removePluginLocales(pluginKey: string, languages: string[]) {
  for (const lng of languages) {
    for (const ns of pluginNamespaces) {
      i18n.removeResourceBundle(lng, `plugin.${pluginKey}.${ns}`);
    }
  }
  // Core 네임스페이스는 EN 기본값으로 복원
  // 현재 언어가 제거된 언어면 EN으로 폴백
}
```

### 블로커 6: Locale 캐시/버전 미정의 (Codex 추가 발견)

**현상:**
- JS 번들은 `?v=` 로 cache-bust (`slots.tsx:185`)
- Locale JSON에 대한 동등한 전략 없음
- Plugin 업데이트 후 구 버전 locale이 캐시에 잔존 가능

**해결 (Phase C-2a):**
- Locale API 응답에 `version` 필드 포함 (plugin updatedAt 기반)
- 클라이언트: `fetch(`/api/plugins/locales/${lng}?v=${version}`)`
- Cache-Control: `max-age=3600, must-revalidate`
- Plugin update/install 이벤트 시 클라이언트 locale 캐시 무효화

---

## 6. 검증 매트릭스 (Codex 권고 반영)

### Phase A 검증 (완료)

| 시나리오 | 검증 방법 | 결과 |
|---|---|---|
| EN 기본 표시 | 브라우저에서 확인 | ✅ |
| KO 전환 | Settings > General에서 변경 | ✅ |
| 새로고침 후 언어 유지 | localStorage 확인 | ✅ |
| 번역 누락 시 EN 표시 | defaultValue 폴백 | ✅ |
| React Error #310 | 의존성 배열 검사 | ✅ 0건 |
| 원본 로직 보존 | git diff 분석 | ✅ |

### Phase C-1 검증 계획

| 시나리오 | 검증 방법 |
|---|---|
| Plugin에서 usePluginTranslation() 동작 | 예제 플러그인에서 번역 표시 확인 |
| Plugin 언어 전환 반응 | Host 언어 변경 시 Plugin UI 갱신 |
| Core EN+KO 기존 동작 유지 | 기존 테스트 전부 통과 |
| Plugin 없이 Core 동작 | Plugin 미설치 시 정상 동작 |

### Phase C-2 검증 계획

| 시나리오 | 검증 방법 |
|---|---|
| saved language 부팅 | KO 선택 후 새로고침 → FOUC 없음 |
| Plugin install → 새 언어 표시 | 언어 선택기에 자동 추가 |
| Plugin uninstall → 언어 제거 | 선택기에서 제거 + EN 폴백 |
| Plugin update → 새 번역 반영 | 캐시 무효화 후 새 번역 표시 |
| 부분 번역 Plugin | Coverage 표시 + 미번역 키 EN 폴백 |
| Plugin worker crash | Locale 서빙 유지 (worker 독립) |
| 복수 Plugin 같은 언어 | 후순위 Plugin override (명확한 순서) |
| 네트워크 오류 시 | EN 폴백 + 경고 toast |

---

## 7. 현재 구현 상태 (PR #3046)

### 기술 스택

| 항목 | 선택 |
|---|---|
| i18n 라이브러리 | i18next v26 + react-i18next v17 |
| 키 구조 | Flat (keySeparator: false) |
| 기본 언어 | 영어 (EN) |
| 지원 언어 | 영어, 한국어 (KO) |
| 언어 저장 | localStorage('paperclip.language') |
| 네임스페이스 | 15개 (common, agents, issues, costs 등) |
| 폴백 | defaultValue → 영어 표시 |

### 적용 범위

| 범주 | 수량 |
|---|---|
| 수정 파일 | 148개 |
| 번역 키 (EN) | ~2,479개 |
| 번역 키 (KO) | ~2,479개 |
| 새 파일 | 34개 (i18n 인프라 + JSON + LanguageSelector) |

### 안전 규칙 (검증 완료)

| 규칙 | 검증 방법 | 결과 |
|---|---|---|
| useMemo/useEffect/useCallback 의존성에 t 금지 | grep 전수검사 | 0건 |
| early return 앞 useTranslation 금지 | 파일별 확인 | 0건 |
| JSON 중복 키 금지 | python3 json.load 검증 | 0건 |
| 원본 비즈니스 로직 변경 금지 | git diff 분석 | 0건 |
| 모든 t() 호출에 defaultValue 포함 | 코드 리뷰 | 100% |

### 테스트 결과

| 테스트 | 결과 |
|---|---|
| Typecheck (tsc) | ✅ 통과 |
| UI Unit Tests | ✅ 83 파일, 440 passed |
| Playwright E2E | ✅ 6 passed |
| 브라우저 콘솔 (Docker) | ✅ EN/KO 24페이지 0 오류 |
| Codex 교차검증 | ✅ 로직 보존 확인 |

---

## 8. 새 언어 추가 가이드

### Phase A 기준 (현재)

1. `ui/src/i18n/locales/{lang}/` 디렉토리 생성
2. EN JSON 파일을 복사하여 번역
3. `ui/src/i18n/index.ts`의 `resources`에 새 언어 추가
4. `ui/src/components/LanguageSelector.tsx`의 `languages` 배열에 추가
5. PR 제출

### Phase C-2 기준 (향후)

1. `pnpm create-paperclip-plugin @scope/plugin-lang-{code}` 스캐폴딩
2. `locales/core/` 하위에 15개 네임스페이스 JSON 생성
3. Manifest에 `locales` 필드 추가
4. `npm publish` 또는 로컬 설치
5. Settings > General에서 자동 표시

---

## 9. 수정 대상 파일 목록 (전체)

### Phase C-1

| 파일 | 변경 내용 |
|---|---|
| `packages/shared/src/types/plugin.ts` | `PluginLocaleDeclaration` 인터페이스, `i18n?` 필드 |
| `packages/shared/src/validators/plugin.ts` | locale 검증 스키마 |
| `ui/src/plugins/bridge-init.ts` | i18n 인터페이스 추가 |
| `packages/plugins/sdk/src/ui/hooks.ts` | `usePluginTranslation()` 구현 |
| `packages/plugins/sdk/src/ui/index.ts` | export 추가 |
| `ui/src/plugins/slots.tsx` | bare-specifier shim 업데이트 |
| `ui/src/main.tsx` | bridge init에 i18n 전달 |

### Phase C-2a (인프라)

| 파일 | 변경 내용 |
|---|---|
| `packages/shared/src/types/plugin.ts` | worker 선택적, capabilities 완화 |
| `packages/shared/src/validators/plugin.ts` | locale-only 검증 규칙 |
| `packages/shared/src/constants.ts` | `CORE_NAMESPACES` 상수 |
| `server/src/services/plugin-loader.ts` | locale discovery, locale-only 활성화 분기 |
| `server/src/services/plugin-lifecycle.ts` | locale-only plugin lifecycle |
| `server/src/routes/plugins.ts` | locale API + languages API |
| `ui/src/i18n/index.ts` | `loadLanguage()` fetch 전환, preload, 정리 로직 |
| `ui/src/plugins/bridge.ts` | `pluginKey` context 추가 |
| `ui/src/main.tsx` | preload 대기 로직 |

### Phase C-2b (KO 이전)

| 파일 | 변경 내용 |
|---|---|
| `ui/src/i18n/index.ts` | KO inline import 제거 |
| `ui/src/components/LanguageSelector.tsx` | 동적 언어 목록 |

### Phase C-2b 신규 생성

| 파일 | 내용 |
|---|---|
| `packages/plugins/plugin-lang-ko/package.json` | KO 언어팩 Plugin |
| `packages/plugins/plugin-lang-ko/src/manifest.ts` | Manifest |
| `packages/plugins/plugin-lang-ko/locales/core/*.json` | 15개 JSON |
| `doc/plugins/LOCALE_PLUGINS.md` | 커뮤니티 가이드 |

---

## 10. 리스크 및 엣지 케이스

| 리스크 | 해결 방안 |
|---|---|
| Key 충돌 (여러 Plugin이 같은 Core 키 제공) | 로드 순서: Core EN → Plugin (후순위 override). Manifest에 선언 필수 |
| 불완전 번역 (50% 키만 제공) | i18next fallback chain: Plugin key → Core EN. Coverage 메타데이터 표시 |
| Plugin 비활성화 → 언어 소실 | fetch 404 → EN 폴백 + 경고 toast. localStorage 언어 유지 |
| Plugin uninstall → locale 잔존 | `removeResourceBundle()` 호출 + 현재 언어 폴백 처리 |
| 캐시 무효화 | Plugin 업데이트 시 `version` 필드 변경 → 클라이언트 re-fetch |
| 파일 I/O 성능 (15 JSON × N plugins) | 서버 메모리 캐시. Plugin enable 시 로드, 응답까지 유지 |
| 네임스페이스 `:` 충돌 | `.`(dot) 구분자 사용: `plugin.linear.messages` |
| 순환 의존성 (Plugin A → Plugin B locale) | Core 네임스페이스만 cross-plugin 허용. Plugin 간 locale 의존 금지 |
| Worker crash → locale 소실 | Locale 서빙을 worker 상태와 분리 (enabled이면 서빙) |
| 첫 렌더 FOUC | saved language preload 완료까지 렌더링 대기 |

---

## 11. 배포 전략

### Phase C-1 배포

```
Week 1: SDK + Bridge 변경 → 스테이징 테스트
Week 1: Plugin custom-namespace 로딩 → 예제 플러그인 검증
Week 2: upstream PR → 리뷰 → 머지
```

### Phase C-2 배포 (단계적)

```
C-2a 인프라:
  Week 1: Manifest + Discovery + API (locale-only 플러그인)
  Week 2: 클라이언트 로딩 + preload + 정리 로직
  Week 3: 통합 테스트 + 안정화

C-2b KO 이전:
  Week 4: KO Plugin 생성 + 이중 소스 테스트 (Core + Plugin 동시)
  Week 5: Core KO 제거 → Plugin 전용 → 프로덕션
  Week 6: 문서화 + 커뮤니티 공개
```

**롤백 전략:**
- KO Plugin이 안정될 때까지 Core에 KO 유지 (이중 소스, 최소 1 릴리스)
- 문제 발견 시 Core KO 복원 (1개 커밋으로 rollback)
- C-2a 인프라 문제 시 C-1 상태로 롤백 (Plugin custom-namespace만)

---

## 12. 공수 요약

| Phase | 공수 | 상태 | 비고 |
|---|---|---|---|
| A | 완료 | ✅ | PR #3046 |
| C-1 | ~15시간 (~2일) | 즉시 가능 | Plugin 자체 UI 번역 |
| C-2a | ~30시간 (~4일) | SDK 성숙 후 | 인프라 (locale-only, API, preload) |
| C-2b | ~20시간 (~2.5일) | C-2a 후 | KO 이전 + 문서화 |
| **합계** | **~65시간 (~8.5일)** | — | Phase A 제외 |

---

## 13. 성공 기준

### Phase C-1 완료 조건

- [ ] Plugin이 `usePluginTranslation()`으로 자체 UI 번역 가능
- [ ] Bridge에 i18n 인터페이스 노출
- [ ] 예제 플러그인에서 번역 동작 확인
- [ ] Core EN+KO 기존 동작 영향 없음

### Phase C-2 완료 조건

- [ ] Core에 EN만 번들 (KO 제거)
- [ ] KO는 Plugin으로 접근 가능
- [ ] LanguageSelector가 동적 언어 목록 표시 (coverage 포함)
- [ ] Plugin 비활성화 시 graceful fallback
- [ ] Plugin uninstall 시 locale 정리
- [ ] Locale 캐시 무효화 동작
- [ ] 첫 렌더 preload (FOUC 없음)
- [ ] 커뮤니티가 문서만으로 새 언어팩 Plugin 생성 가능
- [ ] 번들 크기 감소: ~20-30KB (KO JSON 제거)
- [ ] 언어 전환 응답 시간: <500ms

---

## 14. 교차검증 이력

| 검증 단계 | 도구 | 결과 |
|---|---|---|
| 아키텍처 분석 | Claude (Explore) | Plugin SDK에 i18n hook 없음 확인 |
| 1차 설계 검토 | Codex (consult, xhigh) | Option A feasible, Core language pack은 추가 작업 필요 |
| 최종 3가지 접근법 검증 | Codex (exec, xhigh) | A: RECOMMENDED, B: NOT VIABLE, C: VIABLE |
| A→C 상세 설계 분석 | Claude (Explore) | 7단계 마이그레이션 설계 |
| A→C 상세 설계 교차검증 | Codex (exec, xhigh) | 4개 블로커 + 2개 추가 리스크 발견, C-1/C-2 분리 권고, 공수 상향 |
| 최종 설계 재검토 | Codex (exec, xhigh) | NEEDS REVISION → 6개 수정 사항 반영, C-2 내부 분리 권고 |
| 코드 검증 | Codex (review) | upstream 로직 보존 + i18n 누락 발견→수정 |

---

## 15. 참고 자료

- PR #3046: https://github.com/paperclipai/paperclip/pull/3046
- Plugin Spec: `/doc/plugins/PLUGIN_SPEC.md`
- Plugin Authoring Guide: `/doc/plugins/PLUGIN_AUTHORING_GUIDE.md`
- i18next 공식 문서: https://www.i18next.com/
- react-i18next 공식 문서: https://react.i18next.com/
- Plugin SDK 소스: `/packages/plugins/sdk/src/`
- Bridge 초기화: `/ui/src/plugins/bridge-init.ts`
- Plugin Loader: `/server/src/services/plugin-loader.ts`
- Plugin Lifecycle: `/server/src/services/plugin-lifecycle.ts`
