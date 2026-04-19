# Tutorial 02 — Enable EGO

**목표**: EGO 자율 판단 레이어를 켜고, 사용자 메시지가 어떻게 분류·개입되는지 직접 관찰.
**소요 시간**: 15분
**전제**: [튜토리얼 01](01-hello-agent.md) 완료

## EGO 가 무엇을 하나

EGO 는 사용자 메시지를 받아 **4가지 판단** 중 하나를 내립니다:

| 판단 | 의미 | 예시 |
|------|------|------|
| `passthrough` | 그대로 통과 (개입 불필요) | "안녕" |
| `enrich` | 맥락 보강 후 전달 | "어제 리뷰한 PR 올려도 돼?" → 어제 리뷰 메모리 주입 |
| `redirect` | 다른 에이전트로 전환 | "DB 쿼리 문제" → `db-specialist` 에이전트로 |
| `direct_response` | EGO 가 직접 응답 | "내 페르소나 알려줘" (에이전트 불러올 필요 없음) |

두 계층 구조:
- **빠른 경로** (규칙 기반, ~16ms) — 인사/명령어는 곧바로 passthrough
- **깊은 경로** (LLM 기반, ~2s) — 복잡한 메시지만 판단

## Step 1: EGO 설정 파일 생성

```bash
pnpm --filter @agent-platform/cli dev -- ego active
```

이 명령이 하는 일:
1. `~/.agent/ego/ego.json` 을 기본 설정으로 생성
2. `state` 를 `"active"` 로 설정

출력:
```
EGO state: active
```

## Step 2: 설정 확인

```bash
cat ~/.agent/ego/ego.json
```

주요 필드를 확인합니다:
```json
{
  "schemaVersion": "1.1.0",
  "state": "active",
  "fallbackOnError": true,
  "maxDecisionTimeMs": 3000,
  "llm": null,                              // ← 아직 LLM 미설정
  "thresholds": {
    "minConfidenceToAct": 0.6,
    ...
  },
  "fastPath": {
    "passthroughIntents": ["greeting", "command", "reaction"],
    "maxComplexityForPassthrough": "simple",
    ...
  },
  ...
}
```

`llm: null` 상태에서는 **깊은 경로가 비활성**됩니다. 즉 빠른 경로에서 passthrough 못한 메시지도
그냥 통과됩니다. 나중에 LLM 을 붙입니다.

## Step 3: 빠른 경로 확인

단순 인사를 보내보면:
```bash
pnpm --filter @agent-platform/cli dev -- send "안녕"
```

내부에서 EGO 가:
1. S1 Intake — `StandardMessage` → `EgoSignal` (<1ms)
2. S2 Normalize — `intent: 'greeting'` 분류 (<5ms)
3. `shouldFastExit` — `passthroughIntents` 에 `greeting` 있음 → **빠른 종료 passthrough**
4. 감사 로그에 `ego.fast_exit` 기록

상태 확인:
```bash
pnpm --filter @agent-platform/cli dev -- status
```

출력에:
```
EGO state: active
EGO operational: yes
```

## Step 4: EGO LLM 붙이기

`~/.agent/ego/ego.json` 을 편집해서 `llm` 섹션을 채웁니다:

```json
{
  ...
  "llm": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5-20251001",
    "apiKey": "${ANTHROPIC_API_KEY}",
    "temperature": 0.1,
    "maxTokens": 1024,
    "topP": 0.9
  },
  ...
}
```

**왜 Haiku?** EGO 는 ~25% 의 메시지만 처리하고 매 호출당 ~1800 토큰 정도 사용합니다. 빠르고 저렴한
모델이 적합. 메인 에이전트는 Sonnet 급을 쓰더라도 EGO 는 Haiku 로 비용 최적화.

## Step 5: 깊은 경로 트리거하기

복잡한 메시지로 깊은 경로를 타봅니다:
```bash
pnpm --filter @agent-platform/cli dev -- send \
  "이 프로젝트 전반의 아키텍처를 분석하고 성능과 보안 측면에서 개선점을 찾은 뒤, 각각에 대한 리팩토링 계획을 구체적으로 세워줘"
```

이 메시지는:
- `intent: 'instruction'` — passthroughIntents 에 없음
- `complexity: 'multi_step'` — `maxComplexityForPassthrough: 'simple'` 초과
- → **깊은 경로 진입**

EGO 가 Claude Haiku 를 호출해 `{perception, cognition, judgment}` JSON 으로 판단하고, 다음 중
하나를 내립니다:
- `passthrough` — "이 요청에 EGO 개입은 불필요하다"
- `enrich` — "사용자는 코드 베이스 맥락이 필요할 것" → 시스템 프롬프트에 관련 메모리 주입

## Step 6: Passive 모드 (섀도우 운영)

EGO 판단만 수집하고 실제 개입은 하지 않으려면:
```bash
pnpm --filter @agent-platform/cli dev -- ego passive
```

`state: 'passive'` 에서 EGO 는:
- 모든 판단 수행 (감사 로그에 기록)
- 하지만 `enrich`/`redirect`/`direct_response` 로 결정해도 실제로는 **passthrough 로 강제 변환**

새 배포나 프롬프트 변경 시 실제 사용자 트래픽 영향 없이 EGO 행동을 관찰하는 용도입니다.

## Step 7: 감사 로그 조회

EGO 의 모든 판단은 `~/.agent/ego/audit.db` 에 저장됩니다:

```bash
sqlite3 ~/.agent/ego/audit.db
```

```sql
sqlite> SELECT tag, action, parameters FROM ego_audit
        ORDER BY timestamp DESC LIMIT 5;

ego_decision|ego.fast_exit|{"action":"passthrough","intent":"greeting","complexity":"trivial","pipelineMs":12}
ego_decision|ego.deep_path|{"action":"enrich","intent":"instruction","complexity":"multi_step","pipelineMs":1340,"confidence":0.82,"egoRelevance":0.75}
...
```

### 주요 감사 태그

| tag | 의미 |
|-----|------|
| `ego_decision` | 판단 완료 (fast_exit 또는 deep_path) |
| `ego_timeout` | `maxDecisionTimeMs` 초과 |
| `llm_schema_mismatch` | LLM 응답이 `EgoThinkingResult` 스키마 위반 |
| `llm_out_of_range` | confidence 가 [0,1] 범위 밖 |
| `llm_inconsistent_action` | enrich 인데 enrichment 없음 등 |
| `memory_timeout` | 메모리 검색 타임아웃 (`memory.onTimeout` 규칙 적용) |
| `ego_circuit_open` | 연속 LLM 실패로 서킷 브레이커 발동 |
| `daily_cost_cap_hit` | 일일 비용 한도 초과 → state 자동 다운그레이드 |
| `ego_state_transition` | state 변경 (CLI 또는 자동) |
| `ego_redirect` | 세션 전이 발생 |

## Step 8: 임계값 튜닝

EGO 가 너무 자주/드물게 개입한다면 `thresholds` 를 조정:

```json
"thresholds": {
  "minConfidenceToAct": 0.8,                 // 0.6 → 0.8: 더 확신있는 경우만 개입
  "minRelevanceToEnrich": 0.5,               // 0.3 → 0.5: enrich 문턱 상향
  "maxCostUsdPerDecision": 0.01,             // 0.05 → 0.01: 비용 하드 캡 축소
  "maxCostUsdPerDay": 1.0                    // 일일 한도도 축소
}
```

## Step 9: Fast-path 비율 측정

`ego.json` 의 `fastPath.targetRatio` (기본 0.75) 는 "75% 의 메시지가 빠른 경로에서 passthrough 되어야
한다" 는 목표입니다. 실측 값과 비교해 규칙을 튜닝합니다:

```sql
sqlite> SELECT
          SUM(CASE WHEN action='ego.fast_exit' THEN 1 ELSE 0 END) AS fast,
          SUM(CASE WHEN action='ego.deep_path' THEN 1 ELSE 0 END) AS deep,
          ROUND(1.0 * SUM(CASE WHEN action='ego.fast_exit' THEN 1 ELSE 0 END)
                / COUNT(*), 2) AS ratio
        FROM ego_audit WHERE tag='ego_decision';

fast=18 deep=6 ratio=0.75
```

목표 근처면 OK. 크게 벗어나면:
- 너무 높음 (fast > 0.85) — 중요한 메시지도 passthrough 될 위험 → `maxComplexityForPassthrough`
  를 `trivial` 로 낮추거나 `passthroughIntents` 축소
- 너무 낮음 (fast < 0.65) — 비용·지연 증가 → `passthroughPatterns` 확장

## 튜토리얼 정리

- ✅ `agent ego {off|passive|active}` 로 상태 전환
- ✅ 빠른 경로: 인사/명령/단순 질문은 규칙 기반으로 즉시 통과
- ✅ 깊은 경로: 복잡한 메시지는 EGO LLM 이 판단
- ✅ 4가지 판단 결과 (passthrough/enrich/redirect/direct_response)
- ✅ 감사 로그가 모든 판단을 기록
- ✅ `passive` 모드로 섀도우 운영
- ✅ 임계값 / 목표 비율로 튜닝

## 다음

현재까지는 EGO 가 판단만 하고 기억하지 않습니다. [튜토리얼 03: 메모리 팰리스](03-memory-palace.md)
에서는 대화가 자동 저장되고, EGO 가 과거 맥락을 끌어와 `enrich` 판단을 내리는 구조를 봅니다.

## 관련 문서

- [configuration.md](../configuration.md#egojson--ego-설정) — ego.json 전체 필드 레퍼런스
- [ego-design.md §5](../../../claude/ego-design.md) — 깊은 경로 상세 설계
- [ego-design.md §11](../../../claude/ego-design.md) — E2E 시나리오 트레이스
