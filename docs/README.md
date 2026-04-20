# Agent Platform — Documentation

사용자 가이드·튜토리얼·레퍼런스 모음.

## 빠르게 시작하고 싶다면

1. **[getting-started.md](getting-started.md)** — 설치부터 첫 대화까지 (5분)
2. **[tutorials/01-hello-agent.md](tutorials/01-hello-agent.md)** — 첫 에이전트 튜토리얼

## 차근차근 배우고 싶다면 (Tutorials)

순서대로 따라 하면 플랫폼의 핵심 기능을 모두 경험할 수 있습니다.

| # | 제목 | 학습 내용 | 소요 시간 |
|---|------|-----------|-----------|
| [01](tutorials/01-hello-agent.md) | Hello Agent | `agent send` 기본 사용, 세션 관리, 모델 선택 | 5분 |
| [02](tutorials/02-enable-ego.md) | Enable EGO | EGO 레이어 토글, 빠른 경로 vs 깊은 경로, 감사 로그 | 15분 |
| [03](tutorials/03-memory-palace.md) | Memory Palace | Palace 저장소, 자동 분류, 하이브리드 검색, EGO 메모리 주입 | 15분 |
| [04](tutorials/04-webchat-browser.md) | WebChat Browser | 브라우저에서 WebSocket 으로 스트리밍 대화 | 20분 |
| [05](tutorials/05-telegram-bot.md) | Telegram Bot | Bot API, 그룹 채팅 라우팅, ownerIds | 15분 |
| [06](tutorials/06-custom-tool.md) | Custom Tool | AgentTool 작성, InProcessSandbox, 스킬 패키징, Docker 격리 | 20분 |
| [07](tutorials/07-gateway-tui.md) | Gateway + TUI | 데몬 게이트웨이와 Ink TUI 클라이언트 (ADR-008) | 15분 |
| [08](tutorials/08-webapp-dashboard.md) | Webapp Dashboard | 브라우저 대시보드 (ADR-010), device-identity 등록, 6개 뷰, phase-line | 20분 |

## 레퍼런스 (Reference)

특정 API·명령을 빠르게 찾고 싶을 때.

- **[configuration.md](configuration.md)** — `ego.json` / `persona.json` / 환경 변수 / 모든 설정 필드
- **[reference/cli.md](reference/cli.md)** — `agent send` / `agent status` / `agent ego` 전체 사용법

## 개념 이해 (How it works)

- **[architecture.md](architecture.md)** — 패키지 지도·데이터 흐름·EGO 파이프라인·메모리 검색 전략·운영자 서피스(TUI/Webapp)
- 원본 설계 (한국어): [harness-engineering.md](../../claude/harness-engineering.md), [ego-design.md](../../claude/ego-design.md), [ego-persona.md](../../claude/ego-persona.md), [visualize_architecture.md](../../claude/visualize_architecture.md)

## 이주 (Migration)

- **[migration/v0.2-to-v0.3.md](migration/v0.2-to-v0.3.md)** — v0.2 (enabled+mode) → v0.3 (state enum), 신규 필드

## 사용 사례별 가이드

### "채널을 추가하고 싶어요"
- [튜토리얼 04 — WebChat](tutorials/04-webchat-browser.md)
- [튜토리얼 05 — Telegram](tutorials/05-telegram-bot.md)
- [configuration.md §채널별 설정](configuration.md#채널별-설정) — Slack/Discord/WhatsApp

### "브라우저로 운영/관찰하고 싶어요"
- [튜토리얼 08 — Webapp Dashboard](tutorials/08-webapp-dashboard.md) — Chat/Overview/Channels/Instances/Sessions/Cron 6개 뷰
- 기동: `pnpm --filter @agent-platform/webapp dev` (개발) 또는 `agent gateway start --webapp-dir <dist>` (프로덕션)

### "EGO 를 튜닝하고 싶어요"
- [튜토리얼 02 §Step 8](tutorials/02-enable-ego.md#step-8-임계값-튜닝) — 임계값
- [튜토리얼 02 §Step 9](tutorials/02-enable-ego.md#step-9-fast-path-비율-측정) — Fast-path 비율
- [configuration.md §egojson](configuration.md#egojson--ego-설정) — 모든 필드

### "에이전트가 외부 API 를 쓰게 하고 싶어요"
- [튜토리얼 06 — Custom Tool](tutorials/06-custom-tool.md)
- [packages/agent-worker/src/tools/built-in.ts](../packages/agent-worker/src/tools/built-in.ts) — 기본 도구 예시

### "기억이 너무 쌓여서 관리하고 싶어요"
- [튜토리얼 03 §Step 7 — Compaction](tutorials/03-memory-palace.md#step-7-compaction-오래된-청크-요약)
- [configuration.md §PalaceMemorySystem](configuration.md) — compactor 옵션

### "프로덕션 배포를 하고 싶어요"
- 메시지 버스: [configuration.md §메시지 버스 선택](configuration.md#메시지-버스-선택) — Redis Streams
- 관측: [configuration.md §관측 가능성 설정](configuration.md#관측-가능성-설정) — OTLP exporter
- 인증: [configuration.md §Gateway 설정](configuration.md#gateway-설정) — Bearer 토큰
- 샌드박스: [튜토리얼 06 — Docker](tutorials/06-custom-tool.md#part-3--docker-실행-도구)

## 자주 묻는 질문 (FAQ)

### Q. EGO 는 꼭 켜야 하나요?
A. 아니요. `state: 'off'` 가 기본이며, 이 상태에서 EGO 는 완전히 건너뛰어집니다. 단순 챗봇 용도라면 EGO 없이 충분합니다.

### Q. Anthropic 말고 OpenAI 만 쓸 수 있나요?
A. 메인 에이전트용 `OpenAIAdapter` 는 아직 구현되어 있지 않으나 `ModelAdapter` 인터페이스만 구현하면 동일하게 동작합니다. EGO LLM 은 `ego.json.llm.fallback` 에 OpenAI 지정 가능. 엠베더는 `openAIEmbedder` 가 이미 제공됩니다.

### Q. 데이터베이스는 어디에 저장되나요?
A.
- 세션: `./agent-sessions.db` (CLI 실행 위치)
- 메모리: `~/.agent/memory/palace.db`
- EGO 감사 로그: `~/.agent/ego/audit.db`
- Goals: `~/.agent/ego/goals.json`
- Persona: `~/.agent/ego/persona.json`

### Q. 테스트가 느린데 CI 에서 어떻게 돌리나요?
A. `npx vitest run packages/core` 로 특정 패키지만, 또는 `packages/channels` 만 분리 실행하세요. 전체 440개도 12초 정도입니다.

### Q. Windows 에서 문제가 없나요?
A. 대부분 정상 동작합니다 (`node:sqlite` 네이티브 바인딩 없음). WSL 을 권장하지만 PowerShell 도 가능.

### Q. 스킬은 어디서 받나요?
A. 현재 공식 레지스트리는 없습니다. 직접 작성하거나 [튜토리얼 06](tutorials/06-custom-tool.md) 의 스캐폴딩을 참고하세요.

## 트러블슈팅

| 증상 | 해결 |
|------|------|
| `ANTHROPIC_API_KEY is not set` | `.env` 로딩 확인, 또는 인라인 설정 |
| `440 tests` 중 일부 실패 | `pnpm install` 재실행 (가끔 node_modules 깨짐) |
| `node:sqlite` 없음 | Node.js 22+ 필요 |
| Docker 샌드박스 테스트 실패 | MockContainerRuntime 으로 대체됨 (실제 Docker 불필요). 실행 시만 필요 |
| EGO 가 너무 자주 개입 | `minConfidenceToAct` 를 0.7~0.8 로 상향 |
| 메모리 검색이 엉뚱한 결과 | `preferredWings` 를 맥락에 맞게 지정, 또는 `maxResults` 증가 |

## 기여하기

이 문서에 오류나 불명확한 부분이 있다면:
1. 구현이 실제로 어떻게 동작하는지 `packages/` 해당 모듈 확인
2. 테스트 (`.test.ts`) 가 가장 정확한 사용 예시
3. 원본 설계 (`D:\ai\claude\*.md`) 와 구현이 어긋나면 구현 우선

## 원본 설계 문서

- [harness-engineering.md](../../claude/harness-engineering.md) — 전체 시스템 설계 (v0.7.0, ADR-001~010)
- [ego-design.md](../../claude/ego-design.md) — EGO 내부 설계 (v0.3.0)
- [ego-persona.md](../../claude/ego-persona.md) — 페르소나 시스템 (v0.2.0)
- [visualize_architecture.md](../../claude/visualize_architecture.md) — TUI + Webapp 블록 다이어그램 (v0.6.0)
- [current_process.md](../../claude/current_process.md) — 세션 간 진행 상태 스냅샷
