# Tutorial 01 — Hello Agent

**목표**: 가장 단순한 형태의 대화 에이전트 사용하기. EGO/메모리/도구 없이, Anthropic Claude 에 바로 연결.
**소요 시간**: 5분
**전제**: [getting-started.md](../getting-started.md) 완료 (빌드 + 테스트 통과)

## 준비물

- Anthropic API 키 — [Anthropic Console](https://console.anthropic.com/) 에서 발급
- `.env` 파일에 `ANTHROPIC_API_KEY` 등록

## Step 1: 첫 메시지

```bash
pnpm --filter @agent-platform/cli dev -- send "안녕"
```

출력:
```
안녕하세요! 오늘 무엇을 도와드릴까요?

[tokens: 8→23 | cost: $0.0004 | 1240ms]
```

내부적으로 일어난 일:
1. CLI 가 `StandardMessage` 생성 (`conversation.id='cli-default'`, `channel.type='webchat'`)
2. `./agent-sessions.db` SQLite DB 자동 생성
3. 세션 자동 해석 (기존 것 있으면 재사용, 없으면 생성)
4. EGO 설정 없음 → 스킵
5. `AgentRunner.processTurn` 이 최근 세션 이벤트 로드
6. Anthropic Claude Sonnet 에 스트리밍 호출
7. 응답 토큰이 한 개씩 터미널에 쓰임
8. `session_events` 에 user_message + agent_response 저장

## Step 2: 세션 유지하기 (문맥 기억)

```bash
pnpm --filter @agent-platform/cli dev -- send "내 이름은 대인이야"
# → 반갑습니다 대인님! ...

pnpm --filter @agent-platform/cli dev -- send "내 이름이 뭐였지?"
# → 대인님이라고 말씀하셨죠.
```

CLI 는 기본 세션 id (`cli-default`) 를 재사용하므로 같은 대화가 이어집니다. 대화 이력은
`./agent-sessions.db` 의 `session_events` 테이블에 저장됩니다.

## Step 3: 모델 바꾸기

`.env` 편집:
```bash
AGENT_MODEL=claude-haiku-4-5-20251001
```

Haiku 는 더 빠르고 저렴합니다. 다시 실행:
```bash
pnpm --filter @agent-platform/cli dev -- send "자, 간단히만 대답해: 타입스크립트는 뭐야?"
```

응답 지연·비용이 현저히 줄어든 걸 확인할 수 있습니다.

## Step 4: 커스텀 세션 ID

```bash
pnpm --filter @agent-platform/cli dev -- send \
  --session work-session \
  "일 얘기만 할 세션이야"

pnpm --filter @agent-platform/cli dev -- send \
  --session work-session \
  "내가 지난번에 뭐라고 했지?"
```

`--session <id>` 로 대화 공간을 격리할 수 있습니다.

## Step 5: 플랫폼 상태 확인

```bash
pnpm --filter @agent-platform/cli dev -- status
```

```
=== Agent Platform Status ===

Session DB: ./agent-sessions.db
Session store: OK

EGO: not configured (ego.json not found)

ANTHROPIC_API_KEY: set
OPENAI_API_KEY: not set
```

`EGO: not configured` 는 정상입니다. EGO 설정이 없으면 기본적으로 건너뜁니다.

## 세션 DB 직접 들여다보기

SQLite CLI 로 내부를 살펴볼 수 있습니다:

```bash
sqlite3 ./agent-sessions.db

sqlite> .tables
session_events  sessions

sqlite> SELECT id, conversation_id, status FROM sessions;
sess-01H...|cli-default|active
sess-02H...|work-session|active

sqlite> SELECT event_type, content FROM session_events
        WHERE session_id = (SELECT id FROM sessions WHERE conversation_id='cli-default')
        LIMIT 4;
user_message|안녕
agent_response|안녕하세요! 오늘 무엇을 도와드릴까요?
user_message|내 이름은 대인이야
agent_response|반갑습니다 대인님! ...
```

## 튜토리얼 정리

이 튜토리얼에서는:
- ✅ `agent send` 로 메시지 송수신
- ✅ 세션이 자동 생성·재사용됨
- ✅ 세션 id 로 대화 격리
- ✅ 모델 선택 (`AGENT_MODEL`)
- ✅ SQLite 에 모든 것이 저장됨

## 다음

지금까지는 EGO 없이 "사용자 메시지 → Claude → 응답" 직행 구조였습니다. 다음 튜토리얼에서는
[EGO 자율 판단 레이어](02-enable-ego.md) 를 켜서 판단 로직이 어떻게 개입하는지 봅니다.

## 문제 해결

### 매번 같은 인사만 반복됨
세션 컨텍스트가 제대로 로드되지 않는 것. `./agent-sessions.db` 가 읽기 전용인지, 실행할 때마다
삭제되는지 확인.

### `ANTHROPIC_API_KEY is not set`
쉘이 `.env` 를 자동 로드하지 않을 수 있습니다. 인라인:
```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @agent-platform/cli dev -- send "hi"
```

### Claude 응답이 영어로 나옴
현재 기본은 system prompt 최소 상태. `send.ts` 를 편집하거나, EGO + 페르소나를 도입하면 한국어
선호를 주입할 수 있습니다 (튜토리얼 02 참조).
