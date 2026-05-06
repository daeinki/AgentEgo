import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binaryRunTool, INTERPRETER_WHITELIST, __testing__ } from './binary-run-tool.js';
import { DockerSandbox } from './docker-sandbox.js';
import {
  buildDockerArgs,
  type ContainerResult,
  type ContainerRuntime,
  type RunOptions,
} from './container-runtime.js';
import { ownerPolicy } from '../security/capability-guard.js';

// ─── MockContainerRuntime — captures the RunOptions DockerSandbox would send
// ──────────────────────────────────────────────────────────────────────────

class MockContainerRuntime implements ContainerRuntime {
  public calls: RunOptions[] = [];
  constructor(private readonly result: ContainerResult) {}
  async runOnce(opts: RunOptions): Promise<ContainerResult> {
    this.calls.push(opts);
    return this.result;
  }
}

const ok: ContainerResult = {
  exitCode: 0,
  stdout: 'parsed 1024 rows\n',
  stderr: '',
  durationMs: 8,
  timedOut: false,
};

let skillRoot: string;

beforeAll(() => {
  skillRoot = mkdtempSync(join(tmpdir(), 'binary-run-test-'));
  // Set up a small skill tree for path resolution tests.
  mkdirSync(join(skillRoot, 'csv-parser'), { recursive: true });
  writeFileSync(join(skillRoot, 'csv-parser', 'runner.py'), 'print("hi")', 'utf-8');
  // A second file that's marked executable.
  const execPath = join(skillRoot, 'csv-parser', 'compiled');
  writeFileSync(execPath, '#!/bin/sh\necho ok\n', 'utf-8');
  chmodSync(execPath, 0o755);
  // A non-executable plain file (for the missing exec-bit case).
  writeFileSync(join(skillRoot, 'csv-parser', 'no-exec'), '#!/bin/sh\n', 'utf-8');
  chmodSync(join(skillRoot, 'csv-parser', 'no-exec'), 0o644);
});

afterAll(() => {
  rmSync(skillRoot, { recursive: true, force: true });
});

// ─── Path resolver unit tests ─────────────────────────────────────────────

describe('binary.run — path resolution', () => {
  const { resolveBinaryPath } = __testing__;

  it('resolves a relative path under skillRoot to <mount>/<rel>', () => {
    expect(resolveBinaryPath('csv-parser/runner.py', skillRoot, '/skills', 'python3')).toBe(
      '/skills/csv-parser/runner.py',
    );
  });

  it('passes container-absolute paths through unchanged', () => {
    expect(resolveBinaryPath('/usr/bin/python3', skillRoot, '/skills', undefined)).toBe(
      '/usr/bin/python3',
    );
  });

  it('rejects relative paths that escape skillRoot via ..', () => {
    expect(() => resolveBinaryPath('../etc/passwd', skillRoot, '/skills', 'bash')).toThrow(
      /escapes skillInstallRoot/i,
    );
  });

  it('rejects absolute paths containing /../ traversal segments', () => {
    expect(() =>
      resolveBinaryPath('/usr/bin/../../etc/shadow', skillRoot, '/skills', undefined),
    ).toThrow(/traversal/i);
  });

  it('rejects relative paths to nonexistent files', () => {
    expect(() => resolveBinaryPath('csv-parser/nope.py', skillRoot, '/skills', 'python3')).toThrow(
      /file not found/i,
    );
  });

  it('requires the exec bit on direct (no-interpreter) execution', () => {
    expect(() => resolveBinaryPath('csv-parser/no-exec', skillRoot, '/skills', undefined)).toThrow(
      /lacks execute permission/i,
    );
  });

  it('allows direct execution of an exec-bit-set file', () => {
    expect(resolveBinaryPath('csv-parser/compiled', skillRoot, '/skills', undefined)).toBe(
      '/skills/csv-parser/compiled',
    );
  });

  it('skips the exec bit check when an interpreter is set', () => {
    expect(resolveBinaryPath('csv-parser/no-exec', skillRoot, '/skills', 'bash')).toBe(
      '/skills/csv-parser/no-exec',
    );
  });
});

// ─── End-to-end via DockerSandbox + MockContainerRuntime ──────────────────

describe('binary.run — DockerSandbox integration', () => {
  it('builds a container command with the bind-mount + interpreter prefix', async () => {
    const tool = binaryRunTool({ skillInstallRoot: skillRoot });
    const runtime = new MockContainerRuntime(ok);
    const sandbox = new DockerSandbox(new Map([[tool.name, tool]]), {
      defaultImage: 'alpine',
      runtime,
    });
    const inst = await sandbox.acquire(ownerPolicy('s'));
    const result = await sandbox.execute(
      inst,
      'binary.run',
      {
        path: 'csv-parser/runner.py',
        interpreter: 'python3',
        args: ['--mode', 'fast'],
      },
      30_000,
    );
    await sandbox.release(inst);

    expect(result.success).toBe(true);
    expect(result.output).toContain('parsed 1024 rows');
    expect(runtime.calls).toHaveLength(1);
    const opts = runtime.calls[0]!;
    expect(opts.image).toBe('python:3.12-slim'); // default image, not 'alpine'
    expect(opts.command).toEqual(['python3', '/skills/csv-parser/runner.py', '--mode', 'fast']);
    expect(opts.mounts).toEqual([
      { source: expect.stringContaining('binary-run-test-'), target: '/skills', readonly: true },
    ]);
    expect(opts.cwd).toBe('/tmp');
  });

  it('uses an explicit image override when provided', async () => {
    const tool = binaryRunTool({ skillInstallRoot: skillRoot });
    const runtime = new MockContainerRuntime(ok);
    const sandbox = new DockerSandbox(new Map([[tool.name, tool]]), {
      defaultImage: 'alpine',
      runtime,
    });
    const inst = await sandbox.acquire(ownerPolicy('s'));
    await sandbox.execute(
      inst,
      'binary.run',
      { path: '/usr/bin/ffmpeg', args: ['-version'], image: 'jrottenberg/ffmpeg:latest' },
      10_000,
    );
    await sandbox.release(inst);

    expect(runtime.calls[0]!.image).toBe('jrottenberg/ffmpeg:latest');
    expect(runtime.calls[0]!.command).toEqual(['/usr/bin/ffmpeg', '-version']);
  });

  it('returns a ToolResult error (not throw) on path traversal', async () => {
    const tool = binaryRunTool({ skillInstallRoot: skillRoot });
    const runtime = new MockContainerRuntime(ok);
    const sandbox = new DockerSandbox(new Map([[tool.name, tool]]), {
      defaultImage: 'alpine',
      runtime,
    });
    const inst = await sandbox.acquire(ownerPolicy('s'));
    const result = await sandbox.execute(
      inst,
      'binary.run',
      { path: '../etc/passwd', interpreter: 'bash' },
      5000,
    );
    await sandbox.release(inst);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/escapes skillInstallRoot/i);
    // Crucially: no docker command was issued.
    expect(runtime.calls).toHaveLength(0);
  });

  it('returns a ToolResult error when the interpreter is not whitelisted', async () => {
    const tool = binaryRunTool({ skillInstallRoot: skillRoot });
    const runtime = new MockContainerRuntime(ok);
    const sandbox = new DockerSandbox(new Map([[tool.name, tool]]), {
      defaultImage: 'alpine',
      runtime,
    });
    const inst = await sandbox.acquire(ownerPolicy('s'));
    const result = await sandbox.execute(
      inst,
      'binary.run',
      { path: 'csv-parser/runner.py', interpreter: 'perl' as never },
      5000,
    );
    await sandbox.release(inst);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/whitelist/i);
    expect(runtime.calls).toHaveLength(0);
  });

  it('forwards env vars to the container only', async () => {
    const tool = binaryRunTool({ skillInstallRoot: skillRoot });
    const runtime = new MockContainerRuntime(ok);
    const sandbox = new DockerSandbox(new Map([[tool.name, tool]]), {
      defaultImage: 'alpine',
      runtime,
    });
    const inst = await sandbox.acquire(ownerPolicy('s'));
    await sandbox.execute(
      inst,
      'binary.run',
      {
        path: 'csv-parser/runner.py',
        interpreter: 'python3',
        env: { MY_FLAG: 'true', INPUT_PATH: '/skills/csv-parser/data.csv' },
      },
      5000,
    );
    await sandbox.release(inst);

    expect(runtime.calls[0]!.env).toEqual({
      MY_FLAG: 'true',
      INPUT_PATH: '/skills/csv-parser/data.csv',
    });
  });

  it('exposes interpreter whitelist as a constant for callers / docs', () => {
    expect([...INTERPRETER_WHITELIST]).toEqual(['python3', 'node', 'bash', 'sh']);
  });
});

// ─── buildDockerArgs verifies the --mount flag emission ───────────────────

describe('buildDockerArgs — mount support', () => {
  it('emits --mount type=bind,...,readonly for read-only mounts (default)', () => {
    const args = buildDockerArgs({
      image: 'python:3.12-slim',
      command: ['python3', '/skills/foo.py'],
      timeoutMs: 5000,
      mounts: [{ source: '/host/skills', target: '/skills' }],
    });
    expect(args).toContain('--mount');
    const mountIdx = args.indexOf('--mount');
    expect(args[mountIdx + 1]).toBe('type=bind,src=/host/skills,dst=/skills,readonly');
  });

  it('omits ,readonly when an explicit `readonly: false` is requested', () => {
    const args = buildDockerArgs({
      image: 'python:3.12-slim',
      command: ['sh'],
      timeoutMs: 5000,
      mounts: [{ source: '/host/cache', target: '/cache', readonly: false }],
    });
    const mountIdx = args.indexOf('--mount');
    expect(args[mountIdx + 1]).toBe('type=bind,src=/host/cache,dst=/cache');
  });

  it('emits no --mount flags when mounts is omitted', () => {
    const args = buildDockerArgs({
      image: 'alpine',
      command: ['echo', 'hi'],
      timeoutMs: 1000,
    });
    expect(args).not.toContain('--mount');
  });
});
