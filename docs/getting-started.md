# Getting Started

이 가이드는 Agent Platform 을 로컬에서 **5분 안에** 설치하고 첫 대화를 나누는 과정을 다룹니다.

## 전제조건

| 항목 | 요구사항 | 확인 |
|------|----------|------|
| Node.js | ≥ 22.0.0 | `node --version` |
| pnpm | ≥ 9.0.0 | `pnpm --version` |
| OS | Linux / macOS / Windows (WSL 권장) | — |

Node 22+ 는 내장 SQLite (`node:sqlite`) 를 제공하므로 별도 네이티브 바인딩이 필요 없습니다.

## 1. 리포지토리 설치

```bash
# 이미 받았다면 생략
cd D:/ai/agent-platform

# 의존성 설치
pnpm install
```

설치 시 경고로 표시되는 "build scripts" 승인 안내는 선택사항입니다. 핵심 기능은 스킵해도 동작합니다.

## 2. 빌드 + 테스트 (건강성 확인)

먼저 전체가 정상인지 확인합니다:

```bash
pnpm -r run build    # 13개 패키지 TypeScript 컴파일
npx vitest run       # 58 파일 / 440 테스트
```

끝에 `Tests 440 passed (440)` 가 보이면 베이스라인이 건강합니다.

> 문제가 있으면 [Troubleshooting](#troubleshooting) 섹션을 참고하세요.

## 3. API 키 설정

실제 LLM 호출을 위해 Anthropic API 키가 필요합니다:

```bash
cp .env.example .env
```

`.env` 파일 편집:
```bash
ANTHROPIC_API_KEY=sk-ant-...실제-키...
```

(키가 없어도 **튜토리얼 01** 의 일부는 스크립트된 mock 으로 동작합니다.)

## 4. 첫 대화

CLI 로 메시지를 보냅니다:

```bash
pnpm --filter @agent-platform/cli dev -- send "안녕하세요"
```

처음 실행하면:
1. `./agent-sessions.db` SQLite 파일 자동 생성
2. 기본 세션 자동 생성
3. Anthropic Claude Sonnet 에게 메시지 전송
4. 응답이 **스트리밍** 되어 터미널에 출력됨
5. 토큰 수·비용·지연이 말미에 표시됨

예시 출력:
```
안녕하세요! 오늘 무엇을 도와드릴까요?

[tokens: 8→23 | cost: $0.0004 | 1240ms]
```

## 5. 플랫폼 상태 확인

```bash
pnpm --filter @agent-platform/cli dev -- status
```

출력 예시:
```
=== Agent Platform Status ===

Session DB: ./agent-sessions.db
Session store: OK

EGO: not configured (ego.json not found)

ANTHROPIC_API_KEY: set
OPENAI_API_KEY: not set
```

## 다음 단계

이제 베이스라인이 동작합니다. 다음 중 하나로 확장해보세요:

- **[tutorials/01-hello-agent.md](tutorials/01-hello-agent.md)** — 세션 지속·모델 선택·옵션 자세히
- **[tutorials/02-enable-ego.md](tutorials/02-enable-ego.md)** — EGO 자율 판단 레이어 켜기
- **[tutorials/03-memory-palace.md](tutorials/03-memory-palace.md)** — 대화 자동 기억 + 검색
- **[tutorials/04-webchat-browser.md](tutorials/04-webchat-browser.md)** — 브라우저에서 대화하기
- **[tutorials/05-telegram-bot.md](tutorials/05-telegram-bot.md)** — Telegram 봇으로 배포
- **[tutorials/06-custom-tool.md](tutorials/06-custom-tool.md)** — 나만의 도구 만들기

## Troubleshooting

### `node:sqlite` 모듈을 찾을 수 없음
Node.js 버전이 22 미만입니다. [nodejs.org](https://nodejs.org/) 에서 22+ 를 설치하세요.

### `@agent-platform/core` 를 찾을 수 없음
워크스페이스 링크가 깨졌습니다. 재설치:
```bash
rm -rf node_modules packages/*/node_modules
pnpm install
```

### Windows 경로 이슈
Windows 네이티브 쉘에서 `packages/channels/webchat` 같은 경로가 문제되면 WSL 을 권장합니다. PowerShell 은 대부분 동작하나 일부 SQLite WAL 파일 잠금 이슈가 있을 수 있습니다.

### 테스트가 특정 패키지에서 느림
네트워크 WS 테스트(`control-plane/src/gateway/server.test.ts` 등)는 OS 가 ephemeral 포트를 할당할 때 약간 느립니다. 단일 패키지만 실행하려면:
```bash
npx vitest run packages/core
```

### `ANTHROPIC_API_KEY is not set` 오류
1. `.env` 파일이 루트에 있는지 확인
2. 쉘을 다시 열기 (또는 `source .env`)
3. 또는 인라인: `ANTHROPIC_API_KEY=sk-... pnpm --filter @agent-platform/cli dev -- send "hi"`

### `better-sqlite3` / 네이티브 빌드 오류
이 프로젝트는 `node:sqlite` (내장) 만 사용합니다. `better-sqlite3` 오류가 난다면 로컬 전역 설치에서 오는 것일 가능성이 높습니다. `node_modules` 재설치로 해결됩니다.
