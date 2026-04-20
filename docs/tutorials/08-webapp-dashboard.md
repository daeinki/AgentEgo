# Tutorial 08 — Webapp 대시보드로 운영하기

**목표**: 브라우저 기반 Gateway Dashboard(OpenClaw 스타일) 를 띄우고, ed25519 device-identity 로 **한 번 enroll → 이후 자동 세션 토큰** 인증 구조를 이해한다. Chat 뷰에서 TUI 와 동일한 PhaseLine 이 실시간으로 찍히고, Control 섹션(Overview/Channels/Instances/Sessions/Cron) 이 5초 주기 폴링으로 갱신되는 것까지 확인한다.

**소요 시간**: 20분
**전제**: [튜토리얼 07](07-gateway-tui.md) 완료 (gateway 데몬 + TUI 가 한 번이라도 성공)

## 배경 — TUI 가 있는데 왜 웹 UI 인가

TUI 는 터미널 안에서만 볼 수 있고, 한 화면 = 한 클라이언트다. Web Dashboard(ADR-010) 는 같은 게이트웨이에 **병렬로 붙는** 두 번째 운영자 서피스로, 아래 이점을 준다.

- **멀티탭/멀티윈도**: 같은 게이트웨이에 브라우저 탭 여러 개가 각자 세션을 들고 접속 — Overview 는 A 탭, Chat 은 B 탭.
- **리치 마크다운 렌더링**: TUI 의 단색 텍스트 대신 DOMPurify 로 정제된 마크다운(+ markdown-it-task-lists) 을 Chat 버블에 표시.
- **운영 뷰 내장**: Sessions 테이블, Channels 어댑터 상태, Instances 카운트, Cron 일정, Overview 요약 카드 — 모두 같은 `/rpc` 메서드로 데이터 수급.
- **phase-line 공유**: `packages/core/src/schema/phase-format.ts` 의 `formatPhase` 가 단일 소스 — TUI 의 PhaseLine 과 byte-wise 동일한 `[🔧 bash_run] 3.2s` 문자열을 브라우저에서도 본다.

반면 브라우저가 WebSocket API 제약으로 Authorization 헤더를 못 설정하는 문제가 있어, **OpenClaw 를 따라 ed25519 device-identity** 로 인증 분리(ADR-010):

```
1. 최초 1회:  마스터 Bearer → POST /device/enroll → 브라우저가 자기 pubkey 등록, deviceId 수령
2. 매 연결:   POST /device/challenge → 개인키로 서명 → POST /device/assert → 단명 HMAC 세션 토큰
3. WS:       new WebSocket(url, ['bearer.<sessionToken>'])  — 서브프로토콜에 토큰 실어 보냄
```

마스터 Bearer 토큰은 **enrollment 부트스트랩 1 회용**. 이후 브라우저는 자기 소유의 개인키(IndexedDB) + 단명 세션 토큰(메모리)만 갖는다 — XSS 로 마스터 키가 털릴 위험이 사라진다.

## Part 1 — 두 터미널 띄우기

### Step 1: Gateway 데몬 기동 (터미널 A)

```bash
cd D:/ai/agent-platform
pnpm --filter @agent-platform/cli dev -- gateway start
```

출력 중 다음 줄을 확인:
```
[gateway] listening
  http   http://127.0.0.1:18790
  ws     ws://127.0.0.1:18790/ws   (webchat envelope)
  rpc    ws://127.0.0.1:18790/rpc  (JSON-RPC 2.0)
  auth   Bearer dev-token                     ← enroll 시 이 토큰을 씁니다
```

커스텀 토큰으로 하고 싶다면:
```bash
pnpm --filter @agent-platform/cli dev -- gateway start --auth-token my-secret-123
```

### Step 2: Vite dev 서버 기동 (터미널 B)

```bash
pnpm --filter @agent-platform/webapp dev
```

출력:
```
VITE v6.x.x  ready in 900 ms

  ➜  Local:   http://localhost:5173/
```

Vite 는 `/rpc`, `/healthz`, `/device/*` 요청을 자동으로 게이트웨이로 프록시한다(`vite.config.ts`). 게이트웨이 포트를 변경했다면:
```bash
AGENT_GATEWAY_ORIGIN=http://127.0.0.1:18790 pnpm --filter @agent-platform/webapp dev
```

### Step 3: 브라우저 접속

`http://localhost:5173/` 로 이동. 아래가 보여야 한다:

- **헤더**: 로고 "A" + "AGENT PLATFORM / GATEWAY DASHBOARD", 우측 `● Connecting…` 인디케이터, 테마 토글(☀/☾/◐)
- **사이드바**: Chat / Control(Overview/Channels/Instances/Sessions/Cron Jobs) / Agent(coming soon) / Settings(coming soon) / Resources(coming soon)
- **중앙 오버레이**: "Enroll this browser" 다이얼로그

## Part 2 — Device Enrollment

### Step 4: 마스터 토큰 입력

다이얼로그의 비밀번호 필드에 Step 1 의 `Bearer` 값(`dev-token` 또는 커스텀 토큰) 을 붙여넣고 **Enroll** 클릭.

**내부 동작** (`packages/webapp/src/ui/controllers/device-identity.ts`):
1. `@noble/ed25519.utils.randomPrivateKey()` 로 32B 개인키 생성
2. `getPublicKeyAsync()` 로 대응 공개키 도출
3. 개인키 → IndexedDB (`agent-platform/keys/devicePrivKey`)
4. 공개키 hex → localStorage (`ap:devicePubKeyHex`)
5. `POST /device/enroll` (Bearer 마스터) `{publicKeyHex, name: "browser"}` 전송
6. 응답 `{deviceId}` → localStorage (`ap:deviceId`)

성공하면 오버레이가 사라지고 헤더의 상태가 `● connected` (녹색) 로 바뀐다.

### Step 5: 등록 확인

터미널 A 에서 게이트웨이를 잠시 멈추고 devices.json 확인:

```bash
cat ~/.agent/state/devices.json
```

```json
{
  "version": 1,
  "sessionSecretHex": "…32 bytes hex…",
  "devices": [
    {
      "deviceId": "…uuid…",
      "publicKeyHex": "…64 chars…",
      "name": "browser",
      "enrolledAt": 1729...,
      "lastSeenAt": 1729...
    }
  ]
}
```

여기까지 오면 브라우저는 마스터 Bearer 없이도 이 게이트웨이에 접속할 수 있는 상태다. 다시 Step 1 로 게이트웨이 기동.

## Part 3 — Chat 뷰와 PhaseLine

### Step 6: 첫 메시지

사이드바 **Chat** 클릭 → 하단 입력창에 `안녕` 입력 → Enter.

관찰 포인트:
- 우측 빨간 말풍선에 사용자 메시지
- 좌측 회색 말풍선(Assistant) 이 **스트리밍** 으로 토큰마다 갱신 — 상단에 `◉ ego`, 이어서 `✎ streaming` 같은 상태가 아래 PhaseLine 에 한 줄로 뜸
- 스트리밍이 끝나면 PhaseLine 이 사라짐

### Step 7: PhaseLine 과 TUI 비교

터미널 C 를 더 띄우고:
```bash
pnpm --filter @agent-platform/cli dev -- tui --auth-token dev-token
```

TUI 에서도 같은 세션에 접속해(또는 새 세션에서) 같은 질문을 해보면, 화면 하단 PhaseLine 이 **byte-wise 동일한 문자열** 을 찍는다. 이유는 `packages/core/src/schema/phase-format.ts` 의 `formatPhase` 함수 하나를 두 렌더러가 공유하기 때문(ADR-010 §15 of visualize_architecture.md).

- TUI: `[🔧 bash_run] 3.2s` (Ink `<Text>`)
- Webapp: `[🔧 bash_run] 3.2s` (Lit template 의 `<phase-line>` 컴포넌트)

## Part 4 — Control 섹션 살펴보기

사이드바에서 **Overview** 클릭. 5초 주기로 자동 갱신되는 카드 뷰가 보인다:

- **Version**: 게이트웨이 패키지 버전 (`gateway.health` 와 동일)
- **Uptime**: `1h 23m` 처럼 사람이 읽기 좋은 포맷
- **Sessions**: SessionStore 의 총 세션 수
- **Active agents**: 세션에 붙어있는 고유 agentId 집합 크기
- **Channels**: 등록된 채널 어댑터 수 (RpcDeps.channels 주입 시)
- **Memory**: `process.memoryUsage().rss` (MB)

**Sessions** 탭은 세션 목록 테이블(agentId, channelType, status, updatedAt), **Channels** 탭은 어댑터 상태, **Instances** 탭은 agentId 별 세션 집계, **Cron** 탭은 스케줄 태스크.

> **참고**: `channels.list` / `cron.list` 는 현재 플랫폼 와이어링에서 레지스트리가 주입되지 않아 빈 배열을 반환 — 뷰가 "No channel adapters registered." 같은 정상 빈 상태를 표시한다. ChannelRegistry 실제 집계는 차기 작업.

### Step 8: 세션 리셋

Chat 뷰 하단 **New session** 버튼을 누르면 transcript 가 비워지고 새 sessionId 가 할당된다 — gateway-cli 의 `chat.send` RPC 가 첫 호출에 새 세션을 자동 생성하기 때문.

## Part 5 — 프로덕션 배선 (참고)

개발에서는 Vite dev 서버가 프록시를 맡지만, 실제 운영에서는 gateway 가 직접 빌드된 SPA 를 서빙하는 게 단순하다.

```bash
# 1. webapp 빌드
pnpm --filter @agent-platform/webapp build
# → packages/webapp/dist/ 에 정적 번들 (index.html + assets/)

# 2. gateway 기동 시 webappDir 지정 (현재 CLI 옵션 미노출 — 수동 배선 필요)
#    packages/cli/src/commands/gateway.ts 에서 startPlatform() 호출 시
#    webappDir 필드를 dist 경로로 설정하면 /ui/* 정적 서빙이 활성화됨.
#    Vite 빌드는 base='/ui/' 로 나오므로 자산 경로 자동 일치.
```

이후 브라우저는 `http://127.0.0.1:18790/ui/` 로 접속 — Vite dev 서버 없이 동작.

## 트러블슈팅

### "Loading dashboard…" 만 잠깐 뜨고 빈 화면

커스텀 엘리먼트 업그레이드가 실패한 상태. DevTools Console 에서 에러를 확인. 가장 흔한 케이스는 `useDefineForClassFields: false` 와 Lit decorator 의 조합으로 필드 이니셜라이저가 getter-only 프로퍼티에 할당을 시도하는 것(예: `@query() private x = null;` 에서 `= null` 제거 필요).

### "assert failed (401)" 또는 "challenge failed"

`devices.json` 이 게이트웨이 재시작 사이에 사라졌거나, `sessionSecretHex` 가 바뀐 상황. 다이얼로그가 다시 뜨면 enroll 을 재수행하면 된다. 파일을 강제로 리셋하려면 `rm ~/.agent/state/devices.json` 후 enroll 재시작.

### Vite dev 에서 WS 가 연결되지 않음

`vite.config.ts` 의 `server.proxy` 가 `ws://<gateway>` 를 따라가는지 확인. 기본은 `http://127.0.0.1:18790` 이며, 이 origin 이 `ws://` 로 변환되어 `/rpc` 프록시에 사용된다. 포트가 다르면:
```bash
AGENT_GATEWAY_ORIGIN=http://127.0.0.1:12345 pnpm --filter @agent-platform/webapp dev
```

### 헤더 상태가 `● Reconnecting…` 에서 안 넘어감

게이트웨이가 떠 있는지 먼저 확인(`agent gateway status`). 그 다음 DevTools Network 탭에서 WS 업그레이드가 401 인지 본다. 401 이면 device 세션 토큰 만료/오염 — 페이지 리로드하면 DeviceIdentity 가 assert 를 재수행해 새 토큰을 받는다.

## 다음 단계

- 실제 운영 환경에서 마스터 토큰을 `.env` 또는 시크릿 매니저로 관리, enrollment 는 최초 셋업 한 번
- 추가 뷰(Agents/Skills/Nodes/Config/Debug/Logs/Docs) 는 사이드바에 placeholder — 향후 구현 예정
- `ChannelRegistry` / `CronRegistry` 실구현을 플랫폼 와이어링에 주입하면 Control 뷰 데이터가 활성화됨
- 설계 참고: [visualize_architecture.md §14 Webapp 서피스](../../../claude/visualize_architecture.md) + [§15 Phase-Format 공유](../../../claude/visualize_architecture.md), [harness-engineering.md §3.2B](../../../claude/harness-engineering.md)
