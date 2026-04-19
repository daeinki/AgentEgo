# Tutorial 04 — WebChat in the Browser

**목표**: 브라우저에서 WebSocket 으로 직접 플랫폼과 대화하기. curl 대신 실제 UI 느낌 구현.
**소요 시간**: 20분
**전제**: [튜토리얼 03](03-memory-palace.md) 완료, `run-platform.ts` 설정됨

## WebChat 채널 개요

`@agent-platform/channel-webchat` 패키지는 브라우저 UI 와 통신하는 WS 서버를 띄웁니다.

```
Browser (<script>)          WebChatAdapter           Platform
     │                           │                      │
     ├── ws://host/webchat ─────▶│                      │
     ├── { type: 'identify',     │                      │
     │     userId: 'me' }────────▶                      │
     │                           │ StandardMessage 생성  │
     ├── { type: 'say',          │                      │
     │     text: 'hi' }──────────▶─────── onMessage ───▶│
     │                           │                   EGO/Worker
     │                           │◀──── emit chunk ─────┤
     │◀── { type: 'delta',       │                      │
     │      text: 'Hello' }──────┤                      │
     │◀── { type: 'done' }───────┤                      │
```

## Step 1: 플랫폼 재확인

`run-platform.ts` 가 이미 WebChat 을 기동합니다:

```ts
// 안에서 자동으로:
const webchat = new WebChatAdapter();
await webchat.initialize({
  type: 'webchat',
  port: config.webchatPort ?? 0,  // 0 = ephemeral
  credentials: {},
  ownerIds: config.webchatOwnerIds,
});
```

`ports.webchat` 이 실제 리스닝 포트. 튜토리얼 03에서 `18790` 로 고정했다고 가정.

플랫폼 실행 중이 아니면:
```bash
npx tsx run-platform.ts
```

## Step 2: 브라우저 클라이언트 작성

`public/index.html` 만들기:

```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>Agent WebChat</title>
  <style>
    body { font-family: system-ui; max-width: 640px; margin: 2rem auto; }
    #log { border: 1px solid #ddd; padding: 1rem; height: 400px; overflow-y: auto; white-space: pre-wrap; }
    .user { color: #0066cc; }
    .agent { color: #111; }
    .system { color: #888; font-style: italic; }
    .err { color: #c00; }
    #input { width: 100%; padding: 0.5rem; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <h1>Agent Platform WebChat</h1>
  <div id="log"></div>
  <input id="input" placeholder="메시지 입력 후 Enter"
         autocomplete="off" autofocus>

  <script>
    const log = document.getElementById('log');
    const input = document.getElementById('input');

    function append(cls, text) {
      const line = document.createElement('div');
      line.className = cls;
      line.textContent = text;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    }

    const ws = new WebSocket('ws://127.0.0.1:18790/webchat');
    let currentAgentLine = null;

    ws.addEventListener('open', () => {
      append('system', '[connected]');
      ws.send(JSON.stringify({
        type: 'identify',
        userId: 'browser-user',
        displayName: 'Browser User'
      }));
    });

    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data);
      switch (msg.type) {
        case 'system':
          append('system', `[system] ${msg.text}`);
          break;
        case 'accepted':
          currentAgentLine = document.createElement('div');
          currentAgentLine.className = 'agent';
          currentAgentLine.textContent = '[agent] ';
          log.appendChild(currentAgentLine);
          break;
        case 'delta':
          if (currentAgentLine) currentAgentLine.textContent += msg.text;
          log.scrollTop = log.scrollHeight;
          break;
        case 'done':
          currentAgentLine = null;
          break;
        case 'out':
          append('agent', `[out] ${msg.content.text ?? JSON.stringify(msg.content)}`);
          break;
        case 'error':
          append('err', `[error] ${msg.message}`);
          break;
      }
    });

    ws.addEventListener('close', () => append('system', '[disconnected]'));
    ws.addEventListener('error', () => append('err', '[ws error]'));

    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' && input.value.trim()) {
        append('user', `[me] ${input.value}`);
        ws.send(JSON.stringify({ type: 'say', text: input.value }));
        input.value = '';
      }
    });
  </script>
</body>
</html>
```

## Step 3: 정적 파일 서빙

Node 내장 static 서버 또는 `npx serve public`:

```bash
npx serve public -p 8080
```

```
Serving on http://localhost:8080
```

## Step 4: 브라우저에서 열기

`http://localhost:8080` 열기.

```
[connected]
[system] identified as browser-user
```

이제 타이핑하면 EGO + 메모리 + 에이전트 풀 스택을 통해 스트리밍 응답이 옵니다.

## Step 5: 여러 클라이언트 동시 접속

브라우저 탭을 두 개 열어 같은 `conversationId` 에 속하도록 합니다 (WebChatAdapter 기본: 사용자별
`webchat:{userId}` 이지만, `config.conversationId` 로 고정 가능).

- `userId: 'A'` → conversation `webchat:A`
- `userId: 'B'` → conversation `webchat:B`

다른 사용자는 다른 세션. 두 탭이 같은 사용자로 접속하면 같은 세션 공유 (브로드캐스트).

## Step 6: owner 기반 접근 제어

`run-platform.ts` 의 `webchatOwnerIds` 를 설정하면 해당 사용자만 `isOwner: true` 로 표시됩니다:

```ts
await startPlatform({
  ...
  webchatOwnerIds: ['daein'],  // 이 userId 만 owner
});
```

브라우저가 `identify` 시 `userId: 'daein'` 보내면 서버가 system 메시지로:
```
identified as daein (owner)
```

`isOwner` 플래그는 `StandardMessage.sender.isOwner` 로 전달되어 EGO 나 도구 권한 체크에 쓰입니다.

## Step 7: 응답이 안 올 때 디버깅

브라우저 개발자 도구 → Network → WS 탭에서 프레임을 직접 확인할 수 있습니다.

플랫폼 로그에서:
- `accepted` 가 오면 메시지가 수신됨
- `delta` 가 안 오면 에이전트 워커 단계에서 막힌 것 (API 키? 모델?)
- `error` code=rate_limited 면 gateway rate limit 초과

## Step 8: 실제 UI 프레임워크 통합

위는 vanilla JS. React 훅 예시 ([Lit](https://lit.dev/) 이 스펙 §2.1 에서 권장된 UI 프레임워크):

```ts
// useAgent.ts
import { useEffect, useRef, useState } from 'react';

export function useAgent(url: string, userId: string) {
  const [messages, setMessages] = useState<string[]>([]);
  const wsRef = useRef<WebSocket>();
  const currentResponseRef = useRef<string>('');

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'identify', userId }));
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'delta') {
        currentResponseRef.current += msg.text;
        setMessages((m) => [...m.slice(0, -1), currentResponseRef.current]);
      } else if (msg.type === 'accepted') {
        currentResponseRef.current = '';
        setMessages((m) => [...m, '']);
      }
    };
    return () => ws.close();
  }, [url, userId]);

  const send = (text: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'say', text }));
    setMessages((m) => [...m, `[me] ${text}`]);
  };

  return { messages, send };
}
```

## 튜토리얼 정리

- ✅ `WebChatAdapter` 가 `/webchat` 에서 WS 서버 운영
- ✅ envelope 포맷: `identify` → `say`/`ping` + `system`/`accepted`/`delta`/`done`/`out`/`error`
- ✅ 브라우저에서 직접 통신, 미들웨어 없음
- ✅ 스트리밍으로 실시간 응답
- ✅ `ownerIds` 로 권한 제어

## 다음

브라우저는 로컬 개발 용이하지만 실제 배포는 메신저입니다. [튜토리얼 05: Telegram 봇](05-telegram-bot.md)
에서 Telegram Bot API 어댑터를 연결해보세요.

## 관련 문서

- [architecture.md](../architecture.md#2-14-패키지-지도) — `channels/webchat` 설명
- [packages/channels/webchat/src/envelope.ts](../../packages/channels/webchat/src/envelope.ts) — 프로토콜 원본
