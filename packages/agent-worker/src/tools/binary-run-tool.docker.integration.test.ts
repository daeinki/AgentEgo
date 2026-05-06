import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binaryRunTool } from './binary-run-tool.js';
import { DockerSandbox } from './docker-sandbox.js';
import { DockerContainerRuntime } from './container-runtime.js';
import { ownerPolicy } from '../security/capability-guard.js';

/**
 * Integration test for `binary.run` against **real Docker**.
 *
 * Skipped by default. Run on a host with Docker installed:
 *
 *     AGENT_DOCKER_INTEGRATION=1 \
 *       npx vitest run packages/agent-worker/src/tools/binary-run-tool.docker.integration.test.ts
 *
 * The first run pulls `python:3.12-slim` (~125 MB) — subsequent runs use the
 * cached image. Each `it` spawns its own throwaway container, so cleanup is
 * automatic via Docker's `--rm`.
 *
 * Coverage rationale: unit tests with `MockContainerRuntime` verify the
 * docker-args produced by `binary.run`'s `dockerCommand()`. This file
 * verifies those args **actually do what we claim** under a real container —
 * specifically the bind-mount-readonly invariant and the network/timeout
 * isolation guarantees.
 */

const RUN = process.env['AGENT_DOCKER_INTEGRATION'] === '1';
const IMAGE = 'python:3.12-slim';
const POLICY = ownerPolicy('docker-int');

let skillRoot = '';

describe.skipIf(!RUN)(
  'binary.run — real Docker integration (set AGENT_DOCKER_INTEGRATION=1)',
  () => {
    beforeAll(() => {
      // Idempotent pull (cached after first run). Doing this explicitly so
      // image-fetch latency does not eat into the per-test 60s budget.
      const pull = spawnSync('docker', ['pull', IMAGE], { encoding: 'utf-8' });
      if (pull.status !== 0) {
        throw new Error(
          `docker pull ${IMAGE} failed (status=${pull.status}): ${pull.stderr || pull.stdout}`,
        );
      }
      skillRoot = mkdtempSync(join(tmpdir(), 'binary-run-int-'));
      mkdirSync(join(skillRoot, 'demo'), { recursive: true });
    }, 120_000);

    afterAll(() => {
      if (skillRoot) rmSync(skillRoot, { recursive: true, force: true });
    });

    function makeSandbox(): DockerSandbox {
      const tool = binaryRunTool({ skillInstallRoot: skillRoot });
      return new DockerSandbox(new Map([[tool.name, tool]]), {
        defaultImage: IMAGE,
        runtime: new DockerContainerRuntime(),
      });
    }

    it('runs an agent-authored python script and returns stdout', async () => {
      writeFileSync(
        join(skillRoot, 'demo', 'add.py'),
        `import sys
a, b = int(sys.argv[1]), int(sys.argv[2])
print(f"sum={a+b}")
`,
      );
      const sandbox = makeSandbox();
      const inst = await sandbox.acquire(POLICY);
      const result = await sandbox.execute(
        inst,
        'binary.run',
        { path: 'demo/add.py', interpreter: 'python3', args: ['7', '35'] },
        30_000,
      );
      await sandbox.release(inst);

      expect(result.success).toBe(true);
      expect(result.output).toContain('sum=42');
    }, 60_000);

    it('runs a baked-in binary via container-absolute path', async () => {
      const sandbox = makeSandbox();
      const inst = await sandbox.acquire(POLICY);
      const result = await sandbox.execute(
        inst,
        'binary.run',
        { path: '/usr/local/bin/python3', args: ['--version'] },
        15_000,
      );
      await sandbox.release(inst);

      expect(result.success).toBe(true);
      expect(result.output).toMatch(/Python 3\.12/);
    }, 30_000);

    it('bind-mount is read-only — script CANNOT modify host skill dir from container', async () => {
      writeFileSync(
        join(skillRoot, 'demo', 'attack.py'),
        `import sys
try:
    with open('/skills/demo/attack-marker.txt', 'w') as f:
        f.write('pwned')
    print('WRITE_SUCCEEDED')
except OSError as e:
    print(f'WRITE_BLOCKED: errno={e.errno}')
sys.exit(0)
`,
      );
      const sandbox = makeSandbox();
      const inst = await sandbox.acquire(POLICY);
      const result = await sandbox.execute(
        inst,
        'binary.run',
        { path: 'demo/attack.py', interpreter: 'python3' },
        30_000,
      );
      await sandbox.release(inst);

      expect(result.success).toBe(true); // script ran cleanly (exit 0)
      expect(result.output).toContain('WRITE_BLOCKED');
      expect(result.output).not.toContain('WRITE_SUCCEEDED');
      // The proof: host-side, the marker file does not exist.
      expect(existsSync(join(skillRoot, 'demo', 'attack-marker.txt'))).toBe(false);
    }, 60_000);

    it('direct exec works when the host file has the exec bit (no interpreter)', async () => {
      const sh = join(skillRoot, 'demo', 'compiled.sh');
      writeFileSync(sh, `#!/bin/sh\necho "direct: $1"\n`);
      chmodSync(sh, 0o755);

      const sandbox = makeSandbox();
      const inst = await sandbox.acquire(POLICY);
      const result = await sandbox.execute(
        inst,
        'binary.run',
        { path: 'demo/compiled.sh', args: ['hello'] },
        30_000,
      );
      await sandbox.release(inst);

      expect(result.success).toBe(true);
      expect(result.output).toContain('direct: hello');
    }, 60_000);

    it('network is blocked by default — outbound TCP fails', async () => {
      writeFileSync(
        join(skillRoot, 'demo', 'net.py'),
        `import socket, sys
try:
    socket.create_connection(('1.1.1.1', 53), timeout=2)
    print('NETWORK_REACHABLE')
except OSError as e:
    print(f'NETWORK_BLOCKED: {e.__class__.__name__}')
sys.exit(0)
`,
      );
      const sandbox = makeSandbox();
      const inst = await sandbox.acquire(POLICY);
      const result = await sandbox.execute(
        inst,
        'binary.run',
        { path: 'demo/net.py', interpreter: 'python3' },
        30_000,
      );
      await sandbox.release(inst);

      expect(result.success).toBe(true);
      expect(result.output).toContain('NETWORK_BLOCKED');
      expect(result.output).not.toContain('NETWORK_REACHABLE');
    }, 60_000);

    it('timeout actually terminates the container', async () => {
      writeFileSync(
        join(skillRoot, 'demo', 'sleeper.py'),
        `import time
time.sleep(60)
print('NEVER')
`,
      );
      const sandbox = makeSandbox();
      const inst = await sandbox.acquire(POLICY);
      const start = Date.now();
      const result = await sandbox.execute(
        inst,
        'binary.run',
        { path: 'demo/sleeper.py', interpreter: 'python3' },
        2_000, // 2s — well below the 60s sleep
      );
      const elapsed = Date.now() - start;
      await sandbox.release(inst);

      expect(result.success).toBe(false);
      expect(result.error ?? '').toMatch(/timed out|non-zero exit/i);
      expect(result.output ?? '').not.toContain('NEVER');
      // Allow generous slack for docker CLI cleanup, but well under 60s.
      expect(elapsed).toBeLessThan(15_000);
    }, 30_000);

    it('rejects path traversal without spawning a container', async () => {
      const sandbox = makeSandbox();
      const inst = await sandbox.acquire(POLICY);
      const start = Date.now();
      const result = await sandbox.execute(
        inst,
        'binary.run',
        { path: '../etc/passwd', interpreter: 'bash' },
        10_000,
      );
      const elapsed = Date.now() - start;
      await sandbox.release(inst);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/escapes skillInstallRoot/i);
      // Docker spawn/pull would dwarf this — guard rejection should be sub-second.
      expect(elapsed).toBeLessThan(2_000);
    }, 15_000);
  },
);
