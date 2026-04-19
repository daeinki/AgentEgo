# Tutorial 07 — Gateway 데몬과 TUI 로 대화하기

**목표**: `agent send` 의 one-shot 호출 모델을 벗어나 **오래 떠 있는 gateway 데몬** 과 그 위에 붙는
**Ink 기반 풀 TUI** 로 대화 흐름 경험하기. 재부팅 후 자동 기동까지.

**소요 시간**: 15분
**전제**: [튜토리얼 01](01-hello-agent.md) 완료 (기본 `agent send` 가 한 번이라도 성공)

## 배경 — 왜 필요한가

지금까지 써온 `agent send "..."` 는 매번 프로세스를 띄우고 SessionStore·EGO·AgentRunner 를 새로
와이어링한 뒤 종료한다. 모델·메모리 초기화 비용이 호출마다 발생하고, 여러 채널이 같은 세션에
붙어 있기 어렵다. OpenClaw 의 `openclaw gateway start` + `openclaw tui` 패턴을 참고해 **tmux 서버-
클라이언트 모델** 로 분리했다:

```
┌─────────────────┐      JSON-RPC 2.0 over WebSocket      ┌──────────────────┐
│  agent tui      │◄───────────────────────────────────►  │  agent gateway   │
│ (Ink 클라이언트) │       ws://127.0.0.1:18790/rpc        │  (데몬)           │
└─────────────────┘                                       └──────────────────┘
                                                                  ▲
┌─────────────────┐                                               │
│  agent send     │──── HTTP POST /messages (기존 호환) ─────────►│
└─────────────────┘                                               │
┌─────────────────┐                                               │
│ OS 서비스 매니저 │──── supervise (install/uninstall/restart) ──►│
│ launchd/systemd │                                               │
│ schtasks        │                                               │
└─────────────────┘
```

- 세션·EGO·메모리를 데몬이 소유. 여러 클라이언트(TUI · `agent send` · WebChat 등) 가 같은 세션에
  동시에 붙을 수 있다.
- 로그·pidfile·sessions.db 는 `~/.agent/` 아래로 통일 (`AGENT_STATE_DIR` 로 override).

## Step 1: Gateway 를 포그라운드로 띄우기

가장 단순한 형태. 터미널을 하나 잡고 유지.

```bash
pnpm --filter @agent-platform/cli dev -- gateway start
```

출력:
```
[gateway] starting on port 18790...
[gateway] state dir: C:\Users\daein\.agent
[gateway] listening
  http   http://127.0.0.1:18790
  ws     ws://127.0.0.1:18790/ws   (webchat envelope)
  rpc    ws://127.0.0.1:18790/rpc  (JSON-RPC 2.0)
  auth   Bearer dev-token
[gateway] model: openai/gpt-4o-mini
[gateway] ego state: off
[gateway] pid 12345 · press Ctrl+C to stop
```

이 프로세스가 유지되는 동안 데몬이 살아 있다. 다른 터미널에서 헬스 체크:

```bash
curl http://127.0.0.1:18790/healthz
# { "ok": true, "service": "control-plane" }

pnpm --filter @agent-platform/cli dev -- gateway health
# {
#   "ok": true,
#   "version": "0.1.0",
#   "uptimeMs": 4231,
#   "ports": { "gateway": 18790, "webchat": 37245 },
#   "pid": 12345
# }
```

`gateway health` 는 `curl` 과 달리 **WebSocket + JSON-RPC 2.0** 으로 호출한다. 아래 나올 TUI 도 같은
엔드포인트를 쓴다.

## Step 2: TUI 로 대화하기

또 다른 터미널에서:

```bash
pnpm --filter @agent-platform/cli dev -- tui
```

Ink 가 전체 화면을 잡고 상태줄·히스토리·입력바를 그린다. 메시지를 입력하면 실시간으로 토큰이
흘러나온다 (JSON-RPC `chat.delta` notification).

**키바인딩**:

| 키 | 동작 |
|---|---|
| `Enter` | 입력 전송 |
| `Ctrl+N` | 새 세션 (히스토리 클리어 + server-side 세션 분리) |
| `Ctrl+L` | 화면만 클리어 (세션은 유지) |
| `Ctrl+D` | 종료 |

**멀티 클라이언트**: 같은 `--conversation` 인자를 주면 여러 TUI 인스턴스가 같은 세션에 붙는다.

```bash
# 터미널 B
pnpm --filter @agent-platform/cli dev -- tui --conversation shared

# 터미널 C (같은 세션 관찰)
pnpm --filter @agent-platform/cli dev -- tui --conversation shared
```

한쪽에서 질문하면 다른 쪽도 `chat.history` 로 같은 세션을 불러올 수 있다. 현재 MVP 에서는
스트리밍 deltas 가 **요청을 보낸 클라이언트에게만** 전달되므로, 동시 관찰 UX 는 수동 새로고침
패턴이다 (Ctrl+N → 다시 붙기).

## Step 3: 백그라운드 데몬 (`--detach`)

터미널을 점유하지 않게 자식 프로세스로 fork:

```bash
# 빌드 엔트리를 쓰는 게 안정적 (dev tsx 경로는 fragile)
pnpm --filter @agent-platform/cli build
node packages/cli/dist/program.js gateway start --detach
```

출력:
```
[gateway] spawning detached daemon...
[gateway] running in background
  pid    67890
  port   18790
  stdout C:\Users\daein\.agent\logs\gateway.log
  stderr C:\Users\daein\.agent\logs\gateway.err.log

Use 'agent gateway stop' to shut it down.
```

상태 조회 + 로그 tail + 종료:

```bash
node packages/cli/dist/program.js gateway status
# { "running": true, "pid": 67890, "startedAt": 1776440807042, "health": {...} }

node packages/cli/dist/program.js gateway logs -n 20
node packages/cli/dist/program.js gateway logs --stderr -n 20

node packages/cli/dist/program.js gateway stop
```

PID/port 파일은 `~/.agent/run/` 에 떨어진다. stop 커맨드는 JSON-RPC `gateway.shutdown` 을 보낸 후
stale pidfile 을 자동 정리한다.

## Step 4: OS 서비스로 등록 (재부팅 자동 기동)

데몬을 OS 서비스 매니저 — macOS launchd, Linux systemd --user, Windows schtasks — 에 올려
로그인·재부팅 시 자동 기동.

### Windows (Task Scheduler)

```powershell
pnpm --filter @agent-platform/cli build
node packages/cli/dist/program.js gateway install --start --auth-token my-secret
```

생성물:
- 작업 스케줄러에 `AgentPlatformGateway` 태스크 (트리거: ONLOGON, 권한: HIGHEST)
- `%LOCALAPPDATA%\agent-platform\service-wrappers\AgentPlatformGateway.cmd` (stdio 리다이렉션 래퍼)

검증:
```powershell
# GUI 로그오프 → 로그온 → 자동 기동 확인
node packages/cli/dist/program.js gateway status
# → running: true
```

해제:
```powershell
node packages/cli/dist/program.js gateway uninstall
```

### macOS (launchd LaunchAgent)

```bash
node packages/cli/dist/program.js gateway install --start
```

생성물:
- `~/Library/LaunchAgents/com.agent-platform.gateway.plist` (`RunAtLoad=true`, `KeepAlive=true`)
- `launchctl bootstrap gui/<uid>` 로 즉시 부팅 도메인에 등록

### Linux (systemd --user)

```bash
node packages/cli/dist/program.js gateway install --start
```

생성물:
- `~/.config/systemd/user/agent-platform-gateway.service` (`Restart=on-failure`)
- `systemctl --user enable --now` 로 즉시 기동 + 자동 활성

GUI 세션 없이 부팅 직후부터 띄우려면 `loginctl enable-linger $USER` 를 한 번 실행해 lingering 을 켠다
(서비스 매니저와 별개의 수동 단계).

## Step 5: `agent send` 는 그대로 유지

`agent send` 는 gateway 존재 여부와 상관없이 계속 one-shot 모드로 동작한다. gateway 가 떠 있고
같은 `AGENT_STATE_DIR` 를 공유하면 같은 `sessions.db` 를 쓰므로 세션·히스토리가 겹친다.

```bash
# 데몬 띄운 상태에서 one-shot 으로도 같은 세션 쓰기
pnpm --filter @agent-platform/cli dev -- send --session shared "이거도 같은 세션이야?"
```

TUI 에서 `Ctrl+N` 으로 새 세션을 만든 뒤 `--conversation shared` 로 한 번 주고받으면 이어서 볼 수 있다.

## 정리 — 무엇이 바뀌었나

이 튜토리얼에서 사용한 명령과 산출물:

| 명령 | 결과 |
|---|---|
| `agent gateway start` | 포그라운드 데몬, Ctrl+C 로 정지 |
| `agent gateway start --detach` | 백그라운드 fork, pidfile + port 파일 생성 |
| `agent gateway health` | RPC `gateway.health` — 업타임·포트·pid |
| `agent gateway status` | pidfile 기반 생존 체크 + health RPC |
| `agent gateway logs [-n N] [--stderr]` | 백그라운드 로그 tail |
| `agent gateway stop` | RPC `gateway.shutdown` + pidfile 정리 |
| `agent gateway install [--start] [--label X]` | OS 서비스 매니저 등록 |
| `agent gateway uninstall` | 서비스 해제 |
| `agent gateway restart` | 서비스 재시작 |
| `agent tui` | Ink 기반 대화형 클라이언트 |

**핵심 이해**:
- ✅ 데몬이 세션·EGO·메모리를 소유 → 초기화 비용 없이 연속 대화
- ✅ JSON-RPC 2.0 표준 envelope + `chat.delta` notification 으로 스트리밍
- ✅ `~/.agent/` 하나에 상태 통일 (`AGENT_STATE_DIR` 로 프로젝트별 격리 가능)
- ✅ OS 서비스 매니저 통합으로 로그인/재부팅 자동 기동

## 다음

- 여러 채널 어댑터(Telegram · WebChat 등)를 같은 gateway 에 동시 물려 보고 싶다면
  [튜토리얼 05 — Telegram Bot](05-telegram-bot.md) 을 보고 같은 데몬에 어댑터를 붙이는 패턴을 시도.
- 사용자 정의 슬래시 커맨드/도구를 데몬 안에서 바로 쓰려면 [튜토리얼 06 — Custom Tool](06-custom-tool.md).

## 문제 해결

### `gateway already running at pid N on port P`
같은 `AGENT_STATE_DIR` 에서 이전 인스턴스가 아직 살아 있음. `gateway stop` 으로 먼저 내리거나,
실제로 죽은 경우라면 pidfile 이 stale 일 수 있다:

```bash
ls ~/.agent/run/        # gateway.pid, gateway.port
rm ~/.agent/run/gateway.*
```

`resolveRunning()` 이 stale 탐지 + 자동 정리를 하지만, OS 가 pid 번호를 빠르게 재사용하면
오인할 수 있다. 수동 정리가 가장 확실.

### `gateway did not publish its port within 15000ms`
detach 모드에서 자식 데몬이 부팅에 실패한 경우. stderr 로그를 확인:

```bash
cat ~/.agent/logs/gateway.err.log
```

흔한 원인:
- `OPENAI_API_KEY` 미설정 (모델 어댑터 생성 실패)
- 이미 다른 프로세스가 포트를 점유

### `--detach` 가 dev 모드에서 실패
`tsx` 를 경유한 detach 는 fragile. 빌드 엔트리를 써라:

```bash
pnpm --filter @agent-platform/cli build
node packages/cli/dist/program.js gateway start --detach
```

### TUI 화면이 깨짐 / 입력이 안 됨
Ink 는 풀 TTY 를 요구한다. Git Bash · 구형 cmd · 파이프된 stdout 에서는 정상 동작하지 않는다.
Windows Terminal · iTerm2 · 최신 GNOME Terminal 을 쓰고, `pnpm` 출력을 파이프나 tee 에 걸지 마라.

### 401 Unauthorized
`--auth-token` 이나 `AGENT_GATEWAY_TOKEN` 이 gateway 쪽과 클라이언트 쪽이 다름. 기본값은 양쪽 모두
`dev-token`.
