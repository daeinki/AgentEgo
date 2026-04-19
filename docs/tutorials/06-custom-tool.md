# Tutorial 06 — Custom Tool

**목표**: 에이전트가 호출할 수 있는 커스텀 도구를 만들고 등록하기. 2가지 경로:
1. 인라인 (코드에 직접 등록)
2. 스킬 패키지 (레지스트리 경유)

**소요 시간**: 20분
**전제**: [튜토리얼 03](03-memory-palace.md) 완료

## 도구(AgentTool) 인터페이스

`packages/agent-worker/src/tools/types.ts`:

```ts
export interface AgentTool<A = unknown> {
  readonly name: string;                    // 고유 식별자
  readonly description: string;             // LLM 에게 보여줄 설명
  readonly permissions: Permission[];       // 필요한 권한
  readonly riskLevel: 'low' | 'medium' | 'high' | 'critical';
  readonly inputSchema: Record<string, unknown>;  // JSON Schema
  execute(args: A, ctx: ToolExecutionContext): Promise<ToolResult>;
}
```

## Part 1 — 인라인 도구 (빠른 경로)

### Step 1: 도구 구현

`tools/weather.ts`:

```ts
import type { AgentTool } from '@agent-platform/agent-worker';

interface WeatherArgs {
  city: string;
  unit?: 'celsius' | 'fahrenheit';
}

export function weatherTool(apiKey: string): AgentTool<WeatherArgs> {
  return {
    name: 'weather.lookup',
    description: 'Look up current weather for a city.',
    riskLevel: 'low',
    permissions: [
      { type: 'network', access: 'outbound', domains: ['api.openweathermap.org'] },
    ],
    inputSchema: {
      type: 'object',
      required: ['city'],
      properties: {
        city: { type: 'string', description: '도시 이름 (영문)' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'], default: 'celsius' },
      },
    },
    async execute(args, ctx) {
      const unit = args.unit === 'fahrenheit' ? 'imperial' : 'metric';
      const url = new URL('https://api.openweathermap.org/data/2.5/weather');
      url.searchParams.set('q', args.city);
      url.searchParams.set('units', unit);
      url.searchParams.set('appid', apiKey);

      const start = performance.now();
      try {
        const res = await fetch(url, { signal: ctx.signal });
        if (!res.ok) {
          return {
            toolName: 'weather.lookup',
            success: false,
            error: `HTTP ${res.status}`,
            durationMs: performance.now() - start,
          };
        }
        const data = (await res.json()) as {
          main: { temp: number };
          weather: Array<{ description: string }>;
        };
        const output = `${args.city}: ${data.main.temp}°, ${data.weather[0]?.description}`;
        return {
          toolName: 'weather.lookup',
          success: true,
          output,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          toolName: 'weather.lookup',
          success: false,
          error: (err as Error).message,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}
```

### Step 2: 샌드박스에 등록

```ts
import { InProcessSandbox, PolicyCapabilityGuard, ownerPolicy } from '@agent-platform/agent-worker';
import { weatherTool } from './tools/weather.js';

const tools = new Map([
  ['weather.lookup', weatherTool(process.env.OPENWEATHER_KEY!)],
]);

const sandbox = new InProcessSandbox(tools);

// 세션 정책 설정 (owner 는 모든 low-risk tool 기본 허용)
const policies = new Map([
  ['session-1', ownerPolicy('session-1')],
]);

const guard = new PolicyCapabilityGuard(policies, tools);
```

### Step 3: 에이전트 호출 직전 권한 체크

```ts
// LLM 이 {tool: 'weather.lookup', args: {city: 'Seoul'}} 요청 시
const decision = await guard.check('session-1', 'weather.lookup', { city: 'Seoul' });
if (!decision.allowed) {
  // LLM 에게 "this tool is not allowed: <reason>" 반환
  return;
}

const instance = await sandbox.acquire(policies.get('session-1')!);
const result = await sandbox.execute(instance, 'weather.lookup', { city: 'Seoul' }, 5000);
await sandbox.release(instance);
// result.output → "Seoul: 15.2°, clear sky"
```

> 현재 `AgentRunner` 는 도구 호출을 LLM 과 자동으로 연결하지 않습니다. 도구 호출 loop 는 향후 페이즈
> 에서 추가될 예정이며, 지금은 위처럼 **플랫폼 외부에서** 도구를 호출하는 패턴이 권장됩니다.

## Part 2 — 스킬 패키지

### 스킬이란

재사용 가능한 도구 번들. `manifest.json` + entry point `index.js` 로 구성되며, 서명·해시 검증으로
변조 방지됩니다.

### Step 4: 스킬 디렉토리 스캐폴드

```bash
mkdir -p ~/skill-dev/weather-skill
cd ~/skill-dev/weather-skill
```

`index.js` 작성:

```js
// index.js (빌드된 ES 모듈 형태)
export function createTools({ manifest, installDir }) {
  return [
    {
      name: 'weather.lookup',
      description: manifest.description,
      riskLevel: 'low',
      permissions: [
        { type: 'network', access: 'outbound', domains: ['api.openweathermap.org'] },
      ],
      inputSchema: {
        type: 'object',
        required: ['city'],
        properties: {
          city: { type: 'string' },
          unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
        },
      },
      async execute(args, ctx) {
        // ... weather 로직 (환경 변수에서 apiKey 읽기)
        const key = process.env.OPENWEATHER_KEY;
        if (!key) {
          return { toolName: 'weather.lookup', success: false, error: 'OPENWEATHER_KEY missing', durationMs: 0 };
        }
        // ... (weatherTool 의 body 와 동일)
        return { toolName: 'weather.lookup', success: true, output: 'stub', durationMs: 1 };
      },
    },
  ];
}
```

### Step 5: manifest 생성

```bash
node --input-type=module -e "
import { buildManifest } from '@agent-platform/skills';
import { writeFileSync } from 'node:fs';

const manifest = await buildManifest('.', {
  id: 'weather-skill',
  name: 'Weather Lookup',
  description: 'OpenWeather API wrapper',
  version: '0.1.0',
  author: 'you',
  permissions: [{ type: 'network', access: 'outbound', domains: ['api.openweathermap.org'] }],
  entryPoint: 'index.js',
});
writeFileSync('manifest.json', JSON.stringify(manifest, null, 2));
console.log('Manifest 생성됨:', manifest.id);
"
```

### Step 6: 레지스트리에 설치

```bash
node --input-type=module -e "
import { LocalSkillRegistry } from '@agent-platform/skills';
const reg = new LocalSkillRegistry({
  installRoot: process.env.HOME + '/.agent/skills',
  searchPaths: [process.env.HOME + '/skill-dev'],
});
const result = await reg.install('weather-skill');
console.log(result);
"
```

출력:
```
{
  skillId: 'weather-skill',
  installedAt: 1700000000000,
  version: '0.1.0',
  location: '/home/.../.agent/skills/weather-skill'
}
```

### Step 7: 스킬의 도구를 로드

```ts
import { LocalSkillRegistry, mountInstalledSkills } from '@agent-platform/skills';

const registry = new LocalSkillRegistry({
  installRoot: process.env.HOME + '/.agent/skills',
  searchPaths: [],  // 설치만 확인
});

const { tools: skillTools, errors } = await mountInstalledSkills(registry);

console.log(`Loaded ${skillTools.size} tools, errors=${errors.length}`);
for (const [name, mount] of skillTools) {
  console.log(`  ${name} from skill ${mount.manifest.id}@${mount.manifest.version}`);
}
```

`skillTools` 는 `Map<string, SkillToolMount>`. 각 `mount.tool` 이 `AgentTool` 형태. 이걸
`InProcessSandbox` 에 바로 등록할 수 있습니다:

```ts
const allTools = new Map<string, AgentTool>();
for (const [name, mount] of skillTools) {
  allTools.set(name, mount.tool as AgentTool);
}
const sandbox = new InProcessSandbox(allTools);
```

### Step 8: 변조 감지

스킬 파일을 수동 편집 후 검증:

```bash
echo "tampered" >> ~/.agent/skills/weather-skill/index.js

node --input-type=module -e "
import { LocalSkillRegistry } from '@agent-platform/skills';
const reg = new LocalSkillRegistry({ installRoot: process.env.HOME + '/.agent/skills' });
const v = await reg.verify('weather-skill');
console.log(v);
"
```

출력:
```
{
  skillId: 'weather-skill',
  signatureValid: true,
  hashMatches: false,                   // ← 변조 감지
  message: 'content hash mismatch: expected abc..., got def...'
}
```

### Step 9: HMAC 서명 강제

팀·회사 운영에서는 서명 검증을 강제합니다:

```ts
const registry = new LocalSkillRegistry({
  installRoot: '~/.agent/skills',
  searchPaths: ['./skills'],
  signingSecret: process.env.SKILL_SIGNING_SECRET,  // HMAC 키
});
```

`buildManifest()` 에도 같은 secret 전달:
```ts
const manifest = await buildManifest(dir, {...}, secret);
```

서명 없는 스킬은 `install` 시 `verification failed` 로 거부됩니다.

## Part 3 — Docker 실행 도구

`bash.run` 같은 위험 도구는 컨테이너 격리가 필수:

```ts
import { DockerSandbox, DockerContainerRuntime, bashTool } from '@agent-platform/agent-worker';

const runtime = new DockerContainerRuntime();  // 시스템 docker CLI 사용
const dockerTools = new Map([
  ['bash.run', bashTool({ memoryMb: 256, networkEnabled: false })],
]);

const sandbox = new DockerSandbox(dockerTools, {
  defaultImage: 'alpine:latest',
  runtime,
  // gVisor 런타임 사용 시: gvisorRuntime: 'runsc',
});

const instance = await sandbox.acquire(ownerPolicy('s'));
const result = await sandbox.execute(instance, 'bash.run', { script: 'echo hello' }, 10000);
// result.output → "exit=0\n--- stdout ---\nhello\n"
await sandbox.release(instance);
```

Docker 이미지 사전 pull 필요:
```bash
docker pull alpine:latest
```

## 튜토리얼 정리

- ✅ `AgentTool` 인터페이스로 인라인 도구 작성
- ✅ `InProcessSandbox` + `PolicyCapabilityGuard` 로 실행·권한 관리
- ✅ 스킬 패키지로 도구를 배포·설치·해시 검증
- ✅ `mountInstalledSkills` 로 설치된 스킬을 tool map 으로 모음
- ✅ 변조 감지 + HMAC 서명
- ✅ 위험 도구는 `DockerSandbox` 로 컨테이너 격리

## 다음

이제 튜토리얼 시리즈를 완주했습니다. 더 깊이:

- **[configuration.md](../configuration.md)** — 모든 설정 옵션 레퍼런스
- **[reference/cli.md](../reference/cli.md)** — CLI 명령어 전체 목록
- **[architecture.md](../architecture.md)** — 내부 구조 상세

## 관련 문서

- [packages/agent-worker/src/tools/](../../packages/agent-worker/src/tools/) — 도구 API 원본
- [packages/skills/src/](../../packages/skills/src/) — 스킬 레지스트리 원본
- [harness-engineering.md §3.5](../../../claude/harness-engineering.md) — 권한/샌드박스 설계
