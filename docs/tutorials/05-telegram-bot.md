# Tutorial 05 — Telegram Bot

**목표**: Telegram Bot API 를 통해 모바일/데스크톱에서 플랫폼과 대화.
**소요 시간**: 15분
**전제**: [튜토리얼 03](03-memory-palace.md) 완료, 플랫폼 스크립트 있음

## Telegram 봇 발급

1. Telegram 앱에서 [@BotFather](https://t.me/BotFather) 에게 `/newbot` 전송
2. 봇 이름 + 사용자명 지정 (사용자명은 `_bot` 으로 끝나야 함)
3. BotFather 가 토큰을 돌려줌 (예: `1234567890:ABC-def...`)
4. `/setprivacy` 로 "Disable" — 그룹 채팅에서도 메시지 수신하려면

## Step 1: 환경 변수 설정

`.env` 에 추가:
```bash
TELEGRAM_BOT_TOKEN=1234567890:ABC-def...
TELEGRAM_OWNER_ID=123456789    # 자신의 Telegram 사용자 ID
```

자신의 사용자 ID 찾는 법: [@userinfobot](https://t.me/userinfobot) 에게 아무 메시지 전송.

## Step 2: 플랫폼 스크립트 확장

튜토리얼 03 의 `run-platform.ts` 에 Telegram 채널 추가:

```ts
// run-platform.ts
import 'dotenv/config';
import { startPlatform } from '@agent-platform/cli/dist/runtime/platform.js';
import { AnthropicAdapter } from '@agent-platform/agent-worker';
import { AnthropicEgoLlmAdapter, loadEgoConfig } from '@agent-platform/ego';
import { TelegramAdapter } from '@agent-platform/channel-telegram';

async function main() {
  const egoConfig = await loadEgoConfig();
  if (!egoConfig) throw new Error('ego.json 없음');

  const egoLlm = new AnthropicEgoLlmAdapter();
  if (egoConfig.llm) await egoLlm.initialize(egoConfig.llm);

  const platform = await startPlatform({
    sessionsDbPath: './agent-sessions.db',
    palaceRoot: process.env.HOME + '/.agent/memory',
    egoConfig,
    egoLlm: egoConfig.llm ? egoLlm : undefined,
    modelAdapter: new AnthropicAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY!,
    }),
    gatewayPort: 18789,
    gatewayAuthTokens: ['dev-token'],
    telemetry: { exporter: 'console' },
  });

  // ── Telegram 어댑터 연결 ──
  const ownerIds = process.env.TELEGRAM_OWNER_ID
    ? [Number(process.env.TELEGRAM_OWNER_ID)]
    : undefined;

  const telegram = new TelegramAdapter();
  await telegram.initialize({
    type: 'telegram',
    token: process.env.TELEGRAM_BOT_TOKEN!,
    credentials: {},
    pollTimeoutSec: 30,
    ...(ownerIds ? { ownerIds } : {}),
  });

  telegram.onMessage(async (msg) => {
    // Telegram 메시지 → 플랫폼의 동일 handler 경유
    try {
      const route = await platform.router.route(msg);
      const chunks: string[] = [];
      await (async () => {
        const { AgentRunner } = await import('@agent-platform/agent-worker');
        // 플랫폼이 handler 를 노출하지 않으므로 간단 구현:
        // 실제로는 startPlatform 내부 handler 를 쓰는 게 깔끔함 (future refactor).
      })();
      // 임시 응답 방식 — 플랫폼 내부 handler 재사용 API 가 필요
      await telegram.sendMessage(msg.conversation.id, {
        type: 'text',
        text: `[echo from ${route.agentId}] ${'content' in msg && msg.content.type === 'text' ? msg.content.text : ''}`,
      });
    } catch (err) {
      await telegram.sendMessage(msg.conversation.id, {
        type: 'text',
        text: `오류: ${(err as Error).message}`,
      });
    }
  });

  console.log('Telegram 봇 실행 중');
  console.log('메시지를 봇에게 보내보세요');

  process.on('SIGINT', async () => {
    await telegram.shutdown();
    await platform.shutdown();
    process.exit(0);
  });
}

main().catch(console.error);
```

> 현재 `startPlatform` 은 내부 handler 를 외부에 노출하지 않습니다. 올바른 통합은 plat form 내부에서
> 채널 어댑터를 등록하도록 API 를 확장해야 합니다 ([다음 섹션](#플랫폼-telegram-통합-개선)).

## Step 3: 임시 실행 (간단 echo)

```bash
npx tsx run-platform.ts
```

텔레그램에서 봇에게 메시지 전송 → 플랫폼이 `[echo from default] ...` 로 답합니다. 이는 echo
모드일 뿐 실제 에이전트 호출은 아직 아님. 다음 단계로.

## Step 4: 플랫폼 Telegram 통합 개선

`packages/cli/src/runtime/platform.ts` 를 다음처럼 확장 (실제 적용 시 PR):

```ts
// platform.ts 상단에 추가
export interface PlatformHandles {
  // ... 기존 ...
  handler: MessageHandler;   // ← handler 를 외부에 노출
}

// startPlatform() 마지막 return 에 handler 추가:
return {
  ...
  handler,
  ...
};
```

이렇게 하면 어댑터에서:
```ts
telegram.onMessage(async (msg) => {
  const route = await platform.router.route(msg);
  const outChunks: string[] = [];
  await platform.handler(msg, {
    sessionId: route.sessionId,
    agentId: route.agentId,
    traceId: msg.traceId,
    emit: (text) => outChunks.push(text),
  });
  const response = outChunks.join('');
  if (response) {
    await telegram.sendMessage(msg.conversation.id, { type: 'text', text: response });
  }
});
```

## Step 5: 그룹 채팅

그룹에서 봇을 사용하려면:

1. 봇을 그룹에 추가
2. BotFather 로 privacy 를 disable 해야 그룹의 모든 메시지 수신 가능 (`/setprivacy` → Disable)
3. 그룹 메시지의 `msg.conversation.type` 은 `'group'`
4. `msg.sender.isOwner` 는 그룹에서는 항상 false (DM 에서만 true 가능)

규칙 기반 라우팅으로 그룹별 전용 에이전트 가능:

```ts
import { RuleRouter } from '@agent-platform/control-plane';

platform.router.addRule({
  id: 'dev-team-group',
  conditions: {
    channelType: ['telegram'],
    conversationIds: ['-100...'],  // 그룹 chat_id
  },
  target: { agentId: 'dev-helper' },
  priority: 10,
});
```

## Step 6: 타이핑 인디케이터

응답 생성 중 "생각 중..." 표시:

```ts
telegram.onMessage(async (msg) => {
  await telegram.sendTypingIndicator(msg.conversation.id, true);
  try {
    // ... 에이전트 호출 ...
  } finally {
    // Telegram 의 typing 은 ~10초 자동 만료. 추가 조치 불필요.
  }
});
```

## Step 7: 명령어 처리

Telegram 은 `/start`, `/help` 같은 슬래시 명령을 표준으로 지원. `StandardMessage.content` 는
`{ type: 'command', name: 'start', args: [...] }` 로 자동 변환됩니다 (Telegram 어댑터가 `/foo bar`
텍스트를 감지해 command 타입으로 변환 — 현 구현은 **text 타입 그대로 유지**하므로 패턴 매칭으로
처리):

```ts
telegram.onMessage(async (msg) => {
  if (msg.content.type === 'text' && msg.content.text.startsWith('/')) {
    const [cmd, ...rest] = msg.content.text.slice(1).split(' ');
    if (cmd === 'start') {
      await telegram.sendMessage(msg.conversation.id, {
        type: 'text',
        text: '안녕하세요! 무엇을 도와드릴까요?',
      });
      return;
    }
  }
  // 그 외는 일반 에이전트 경로
});
```

EGO 의 `fastPath.passthroughPatterns` 에 `/start`, `/help` 등이 이미 포함되어 있어 EGO 가 빠르게
빠져나갑니다.

## Step 8: 봇 리스트업

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"
```

봇 사용자명·ID 확인 용도. 운영 중 디버깅에 유용합니다.

## 튜토리얼 정리

- ✅ BotFather 로 봇 토큰 발급
- ✅ `TelegramAdapter` 롱폴링 시작
- ✅ `onMessage` 핸들러로 플랫폼 경유 응답
- ✅ `ownerIds` 로 `isOwner` 플래그 부여
- ✅ 그룹 채팅 라우팅 규칙
- ✅ 타이핑 인디케이터

## 다음

나만의 도구를 만들어 에이전트가 쓰게 하려면 [튜토리얼 06: 커스텀 도구](06-custom-tool.md) 로.

## 보안 주의

- **토큰 노출 금지** — `.env` 파일을 `.gitignore` 에 포함 (`.env.example` 만 커밋)
- **ownerIds 필수** — 공개 봇을 `ownerIds` 없이 운영하면 누구나 사용 가능
- **rate limit** — `ApiGateway` 는 RateLimiter 포함. Telegram 직결은 아직 아니므로 자체 보호 필요

## 관련 문서

- [packages/channels/telegram/src/adapter.ts](../../packages/channels/telegram/src/adapter.ts) — 어댑터 구현
- [Telegram Bot API docs](https://core.telegram.org/bots/api) — 공식 API
