# Agent Platform

차세대 AI 에이전트 플랫폼 — **OpenClaw 교훈을 반영한 분리 가능한 Control Panel + 자율 판단 EGO 레이어 + Palace 구조 장기 기억**.


## 핵심 기능

- **EGO 레이어** — 메시지 버스와 Control Panel 사이에서 자율 판단. `passthrough`/`enrich`/`redirect`/`direct_response` 4가지 경로. 규칙 기반 빠른 경로(~16ms) + LLM 기반 깊은 경로(~2s).
- **Palace 메모리** — SQLite FTS5 + 벡터 코사인 하이브리드 검색. `personal`/`work`/`knowledge`/`interactions` 4-wing 도메인 분류.
- **5개 채널 어댑터** — WebChat / Telegram / Slack / Discord (Gateway WS) / WhatsApp (baileys).
- **도구 샌드박스** — In-process + Docker/gVisor, CapabilityGuard 권한 검증.
- **페르소나 진화** — 대화에서 학습되는 AI 성격. 이식 가능한 `persona.json`.
- **관측 가능성** — OpenTelemetry 통합 (console/memory/OTLP).
- **메시지 버스** — InProcessBus (단일 프로세스) / Redis Streams (분산).
- **스킬 시스템** — 서명된 스킬 레지스트리 + 동적 tool 로더.
- **워크플로** — 선언적 DSL 인터프리터 (`sequence`/`parallel`/`branch`/`tool_call`).
- **디바이스 노드** — macOS/iOS/Android/Linux/Windows 셸 페어링 프로토콜.

## 빠른 시작

```bash
# 1. 의존성 설치
pnpm install

# 2. API 키 설정
cp .env.example .env
# .env 편집: OPENAI_API_KEY 등록

# 3. 초기 환경 설정
cp agent_system-prompt.md.template ~/.agent/system-prompt.md
cp agent_ago_system-prompt.md.template ~/.agent/ego/system-prompt.md
cp agent_ago_ego.json_template ~/.agent/ego/ego.json
# 본인이 원하는 방식으로 prompt 수정 혹은 기본 값 사용

# 4. 빌드 + 테스트 (건강성 확인)
pnpm -r run build
npx vitest run
# → 608+ tests passed

# 5. 첫 대화
pnpm --filter @agent-platform/cli dev -- send "안녕하세요"
```

더 자세한 시작은 [docs/getting-started.md](docs/getting-started.md) 참조.

## 크로스플랫폼 개발 (Windows ↔ Linux/WSL)

본 레포는 Windows (PowerShell / cmd) 와 Linux (WSL 또는 네이티브) 를 동시에
지원한다. [`.npmrc`](./.npmrc) 의 `supported-architectures` 설정 덕분에 한 번의
`pnpm install` 로 **양 플랫폼의 native 바이너리 (esbuild, rollup, tsx, vitest, oxlint 등) 를 동시에 설치** 해, 같은 `node_modules` 를 두 OS 가 공유할 수 있다.

```bash
# Windows PowerShell
cd D:\ai\agent-platform
pnpm install
pnpm --filter @agent-platform/cli dev gateway start

# WSL Ubuntu — 같은 디렉토리, 재설치 불필요
cd /mnt/d/ai/agent-platform
pnpm --filter @agent-platform/cli dev gateway start
```

Windows 에서 `pnpm install` 을 돌리고 WSL 로 넘어왔을 때 `@esbuild/linux-x64
is missing` 같은 오류가 나면 `.npmrc` 가 적용된 상태에서 `pnpm install` 을
한 번 더 돌려주면 된다. 한 플랫폼만 쓴다면 불필요한 `supported-architectures`
라인을 지워 `node_modules` 크기를 절반으로 줄일 수 있다 (약 50-100 MB 차이).

## 디버깅 · trace 조회

Gateway 는 턴마다 파이프라인 블록(G3 · P1 · E1 · W1 · R1/R2/R3 · M1 · S1 · K1/K2 등) 이벤트를 `<stateDir>/trace/traces.db` 에 기록한다. `agent trace` 서브커맨드로 조회한다.

| 서브커맨드 | 용도 | 주요 옵션 |
|---|---|---|
| `trace list` | 최근 trace 최신순 나열 | `-s, --session <id>` · `-n, --limit <n>` (기본 20) |
| `trace show <traceId>` | 특정 trace 의 블록 타임라인 | `--format text\|json` (기본 text) |
| `trace last` | 가장 최근 trace 1건 | `-s, --session <id>` · `--format text\|json` |
| `trace export <traceId>` | trace 를 JSON/NDJSON 덤프 (공유·분석용) | `--format json\|ndjson` (기본 json) |

```bash
# 최근 5건 목록
pnpm --filter @agent-platform/cli dev -- trace list -n 5

# 방금 턴의 블록별 타임라인 — 응답이 느릴 때 어느 블록이 지연됐는지 확인
pnpm --filter @agent-platform/cli dev -- trace last

# 특정 trace 상세 (text / json 선택)
pnpm --filter @agent-platform/cli dev -- trace show trc-01JA...
pnpm --filter @agent-platform/cli dev -- trace show trc-01JA... --format json

# 외부 분석용 NDJSON 내보내기
pnpm --filter @agent-platform/cli dev -- trace export trc-01JA... --format ndjson > turn.ndjson
```

> **주의**: pnpm 이 CLI 옵션(`-n 5`, `-s …` 등) 을 자기 옵션으로 해석하지 않도록
> `dev` 와 `trace` 사이에 반드시 **`--`** 를 넣어야 한다.

### trace 기록 끄기·유지기간

| 환경 변수 | 기본값 | 의미 |
|---|---|---|
| `AGENT_TRACE=0` | (on) | 턴 trace 기록 비활성화 (`NoopTraceLogger` 로 교체) |
| `AGENT_TRACE_RETENTION_DAYS` | `14` | gateway 부팅 시 해당 일수 이전 row prune |

자세한 block naming convention (G3/P1/E1/W1/R1/R2/R3/M1/S1/K1/K2 등) 과 각 블록의 입력·처리·출력 규약은 설계 문서 [`visualize_architecture.md`](./packages/skills/builtin/architecture-lookup/visualize_architecture.md) §13 "TraceLogger" 참조. 런타임에 에이전트가 같은 문서를 참조할 수 있도록 `architecture-lookup` 내장 스킬이 번들되어 있으며 (자동 시드), `architecture.lookup` / `architecture.search` 두 툴로 섹션 단위 조회 가능.

`architecture-lookup` 과 나란히 `trace-lookup` 내장 스킬도 번들된다. 에이전트 런타임에서 `trace.list` / `trace.show` / `trace.last` 세 툴로 자기 자신의 최근 파이프라인 이벤트를 조회할 수 있어 EGO 의 자기 인식·자체 디버깅("직전 턴에서 어떤 tool 을 호출했나?", "어느 블록이 느렸나?") 에 사용된다. DB 는 CLI 와 동일한 `<stateDir>/trace/traces.db` 를 read-only 로 열며, 권한 선언 없음.

## 문서

- **[docs/README.md](docs/README.md)** — 문서 전체 인덱스
- [docs/getting-started.md](docs/getting-started.md) — 설치부터 첫 대화까지
- [docs/architecture.md](docs/architecture.md) — 14개 패키지 구조·데이터 흐름
- [docs/configuration.md](docs/configuration.md) — `ego.json` / `persona.json` / 환경 변수 레퍼런스
- [docs/tutorials/](docs/tutorials/) — 6개 튜토리얼 (단순 에이전트 → EGO → 메모리 → 채널 → 도구)
- [docs/reference/cli.md](docs/reference/cli.md) — CLI 명령어 레퍼런스
- [docs/migration/v0.2-to-v0.3.md](docs/migration/v0.2-to-v0.3.md) — 기존 설정 마이그레이션

## 패키지 구조 (14개)

| 패키지 | 설명 |
|--------|------|
| [`@agent-platform/core`](packages/core) | 공유 타입·TypeBox 스키마·contracts (14개 인터페이스) |
| [`@agent-platform/control-plane`](packages/control-plane) | SessionManager + RuleRouter + ApiGateway (HTTP+WS) |
| [`@agent-platform/ego`](packages/ego) | S1~S7 EGO 파이프라인 + GoalStore + PersonaManager + AuditLog |
| [`@agent-platform/memory`](packages/memory) | PalaceMemorySystem + FTS5 + cosine + LlmCompactor |
| [`@agent-platform/agent-worker`](packages/agent-worker) | AgentRunner + PromptBuilder + Sandbox + built-in tools |
| [`@agent-platform/observability`](packages/observability) | OTel tracer + metrics + OTLP exporter |
| [`@agent-platform/skills`](packages/skills) | LocalSkillRegistry + skill 로더 + tool 등록기 |
| [`@agent-platform/message-bus`](packages/message-bus) | InProcessBus + RedisStreamsBus |
| [`@agent-platform/workflow`](packages/workflow) | Workflow DSL + 인터프리터 |
| [`@agent-platform/device-node`](packages/device-node) | 디바이스 WS 프로토콜 (페어링/하트비트/푸시) |
| [`@agent-platform/cli`](packages/cli) | CLI 명령어 + 런타임 플랫폼 와이어링 |
| [`@agent-platform/channel-webchat`](packages/channels/webchat) | 브라우저 WebSocket 어댑터 |
| [`@agent-platform/channel-telegram`](packages/channels/telegram) | Telegram Bot API 어댑터 |
| [`@agent-platform/channel-slack`](packages/channels/slack) | Slack Events API + Web API |
| [`@agent-platform/channel-discord`](packages/channels/discord) | Discord REST + Gateway WS |
| [`@agent-platform/channel-whatsapp`](packages/channels/whatsapp) | baileys 기반 (옵셔널 peer) |

## 빌드·테스트 상태

- **빌드**: 13/13 패키지 ✅
- **테스트**: 440/440 ✅ (58 파일)
- **타입 체크**: `strict: true` + `exactOptionalPropertyTypes: true` + `noUncheckedIndexedAccess: true`

## 요구사항

- Node.js ≥ 22
- pnpm ≥ 9
- (선택) Docker — `DockerSandbox` 사용 시
- (선택) Redis — `RedisStreamsBus` 사용 시
- (선택) Anthropic / OpenAI API 키 — 실제 LLM 호출 시

## 라이선스

[MIT License](./LICENSE) © 2026 Inki Dae.

저작권 고지와 이 허가 문구를 포함하는 한, 복사·수정·배포·재라이선스·상업적 사용이 모두 자유롭다. 자세한 전문은 [`LICENSE`](./LICENSE) 파일 참조.
