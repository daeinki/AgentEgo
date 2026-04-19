# CLI Reference

`@agent-platform/cli` 의 모든 명령어 레퍼런스.

## 실행 방법

### 개발 (빌드 없이)

```bash
pnpm --filter @agent-platform/cli dev -- <command> [options]
```

### 빌드 후 (글로벌 설치 가능)

```bash
pnpm --filter @agent-platform/cli run build
node packages/cli/dist/program.js <command> [options]

# 또는 프로그램 링크 후:
pnpm --filter @agent-platform/cli link --global
agent <command> [options]
```

## 전역 옵션

모든 명령어에서 사용 가능:

| 옵션 | 의미 |
|------|------|
| `--help` | 명령어 도움말 |
| `--version` | `agent-platform` 버전 출력 |

## 명령어

### `agent send <message>`

에이전트에게 메시지를 보내고 스트리밍 응답 받기.

**인수**
| 인수 | 필수 | 설명 |
|------|------|------|
| `<message>` | ✅ | 사용자 메시지 (따옴표로 감싸는 것 권장) |

**옵션**
| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `-s, --session <id>` | 자동 생성 | 세션 ID (같은 ID 재사용 시 대화 이력 유지) |
| `-a, --agent <id>` | `default` | 에이전트 ID |
| `--db <path>` | `./agent-sessions.db` | 세션 DB 경로 |

**예시**
```bash
# 기본 전송
agent send "안녕하세요"

# 세션 지정
agent send --session work-chat "일 얘기만 하자"
agent send --session work-chat "아까 뭐라고 했지?"

# 다른 DB 파일
agent send --db /tmp/test.db "임시 세션"
```

**출력 형식**
```
<스트리밍된 응답 텍스트>

[tokens: <in>→<out> | cost: $<amount> | <ms>ms]
```

**동작**
1. `StandardMessage` 생성 (channel=webchat, sender.isOwner=true)
2. `SessionStore.resolveSession()` 으로 세션 해석/생성
3. `ego.json` 있으면 EGO 경유 (`state ∈ {passive, active}` 일 때)
4. `AnthropicAdapter.stream()` 으로 LLM 스트리밍
5. 세션 DB 에 user_message + agent_response 이벤트 저장
6. 통계 출력

### `agent status`

플랫폼 상태 확인.

**옵션**
| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--db <path>` | `./agent-sessions.db` | 세션 DB 경로 |

**예시**
```bash
agent status
```

**출력 예시**
```
=== Agent Platform Status ===

Session DB: ./agent-sessions.db
Session store: OK

EGO state: active
EGO operational: yes
EGO LLM: anthropic/claude-haiku-4-5-20251001

ANTHROPIC_API_KEY: set
OPENAI_API_KEY: not set
```

### `agent ego <action>`

EGO 레이어 상태 관리.

**인수**
| 인수 | 설명 |
|------|------|
| `<action>` | `off` \| `passive` \| `active` \| `on`(=`active` 별칭) \| `status` |

**옵션**
| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--config <path>` | `~/.agent/ego/ego.json` | EGO 설정 파일 경로 |

**예시**
```bash
# EGO 끄기
agent ego off

# 섀도우 운영 (판단만, 개입 안 함)
agent ego passive

# 전체 활성화
agent ego active

# 상태 확인
agent ego status
```

**`agent ego status` 출력 예시**
```
=== EGO Status ===

Config: /home/you/.agent/ego/ego.json
Schema version: 1.1.0
State: active
Fallback on error: true
Max decision time: 3000ms

LLM: anthropic/claude-haiku-4-5-20251001

Fast path intents: greeting, command, reaction
Max passthrough complexity: simple
Target fast-path ratio: 0.75
Daily cost cap: $5
```

**`state` 값**
- `off` — 버스 → Control Panel 직행 (EGO 미호출)
- `passive` — EGO 판단 수행, 개입 없음 (관측용)
- `active` — EGO 판단 + 개입 (운영 모드)

**동작**
1. 설정 파일 로드 (없으면 기본값으로 생성)
2. 레거시 키 제거 (`enabled`, `mode`)
3. `state` 필드 업데이트
4. 파일 저장

첫 실행 시 `~/.agent/ego/` 디렉토리 + `ego.json` 을 자동 생성합니다. 기본 설정은
schemaVersion=1.1.0, llm=null 이므로 깊은 경로를 사용하려면 LLM 필드를 수동 채워야 합니다
([configuration.md](../configuration.md#egojson--ego-설정) 참조).

## 환경 변수

CLI 는 `.env` 파일을 자동 로드하지 않습니다 (dotenv 통합은 CLI 호출 방식에 따라 다름). 안전한 방식:

```bash
# 방법 1: 쉘 export
export ANTHROPIC_API_KEY=sk-ant-...
agent send "hi"

# 방법 2: 인라인
ANTHROPIC_API_KEY=sk-ant-... agent send "hi"

# 방법 3: dotenv-cli
npx dotenv-cli -- agent send "hi"
```

| 변수 | 필수 | 용도 |
|------|------|------|
| `ANTHROPIC_API_KEY` | ✅ (LLM 호출 시) | Claude API 키 |
| `AGENT_MODEL` | — | 기본 에이전트 모델 (기본: `claude-sonnet-4-20250514`) |
| `OPENAI_API_KEY` | — | 엠베더·폴백 |

## 종료 코드

| 코드 | 의미 |
|------|------|
| `0` | 정상 종료 |
| `1` | 일반 오류 (잘못된 옵션, 세션 DB 접근 실패 등) |

## 알려진 제약

- **도구 호출 자동화 없음** — 현재 `send` 는 도구 호출 루프를 돌리지 않습니다. 도구를 쓰는
  에이전트는 `startPlatform()` 으로 직접 와이어링 필요 ([튜토리얼 06](../tutorials/06-custom-tool.md)).
- **채널 어댑터 미통합** — `send` 는 webchat 타입 메시지만 생성. Telegram/Slack 등은 별도 프로세스
  ([튜토리얼 05](../tutorials/05-telegram-bot.md)).
- **메모리 미통합** — `send` 는 `AgentRunner` 에 `memory` dep 를 전달하지 않습니다. 메모리 통합은
  `startPlatform()` 에서만 활성 ([튜토리얼 03](../tutorials/03-memory-palace.md)).

## 향후 추가 예정 명령어

현 시점 미구현, 차후 PR 에서 추가 권장:

- `agent serve` — 전체 플랫폼 (`startPlatform`) 을 CLI 로 실행
- `agent memory search <query>` — 메모리 직접 검색
- `agent memory ingest <file>` — 수동 ingest
- `agent skill install <id>` — 스킬 설치 (현재는 `LocalSkillRegistry` 직접 호출)
- `agent skill list` — 설치된 스킬 목록
- `agent goals` — Goal 조회/생성/완료
- `agent persona status` — 페르소나 현재 상태
- `agent persona reset` — 페르소나 초기화

## 관련 문서

- [getting-started.md](../getting-started.md) — 첫 실행
- [configuration.md](../configuration.md) — 설정 파일
- [tutorials/01-hello-agent.md](../tutorials/01-hello-agent.md) — `send` 심화
- [packages/cli/src/program.ts](../../packages/cli/src/program.ts) — 구현 원본
