import { describe, it, expect, vi } from 'vitest';
import { DockerSandbox } from './docker-sandbox.js';
import { bashTool } from './bash-tool.js';
import { fsReadTool } from './built-in.js';
import { buildDockerArgs, type ContainerResult, type ContainerRuntime, type RunOptions } from './container-runtime.js';
import { ownerPolicy } from '../security/capability-guard.js';
import { tmpdir } from 'node:os';

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
  stdout: 'hello\n',
  stderr: '',
  durationMs: 12,
  timedOut: false,
};

const nonZero: ContainerResult = {
  exitCode: 42,
  stdout: '',
  stderr: 'oops',
  durationMs: 5,
  timedOut: false,
};

const timedOut: ContainerResult = {
  exitCode: -1,
  stdout: '',
  stderr: '',
  durationMs: 10_000,
  timedOut: true,
};

describe('buildDockerArgs', () => {
  it('produces hardened defaults (network none, read-only, no-new-privileges)', () => {
    const args = buildDockerArgs({
      image: 'alpine',
      command: ['echo', 'hi'],
      timeoutMs: 5000,
    });
    expect(args).toContain('--network');
    expect(args).toContain('none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges:true');
    // image comes before command args
    const imageIdx = args.indexOf('alpine');
    expect(imageIdx).toBeGreaterThan(-1);
    expect(args[imageIdx + 1]).toBe('echo');
    expect(args[imageIdx + 2]).toBe('hi');
  });

  it('allows network when explicitly enabled', () => {
    const args = buildDockerArgs({
      image: 'alpine',
      command: ['echo'],
      timeoutMs: 1,
      limits: { networkEnabled: true, readOnly: false },
    });
    expect(args).not.toContain('none');
    expect(args).not.toContain('--read-only');
  });

  it('forwards cpus and memory limits', () => {
    const args = buildDockerArgs({
      image: 'alpine',
      command: ['ls'],
      timeoutMs: 1,
      limits: { cpus: 0.5, memoryMb: 256 },
    });
    const idxCpu = args.indexOf('--cpus');
    expect(args[idxCpu + 1]).toBe('0.5');
    const idxMem = args.indexOf('--memory');
    expect(args[idxMem + 1]).toBe('256m');
  });

  it('passes --runtime when set (gVisor)', () => {
    const args = buildDockerArgs({
      image: 'alpine',
      command: ['ls'],
      timeoutMs: 1,
      runtime: 'runsc',
    });
    expect(args).toContain('--runtime');
    expect(args[args.indexOf('--runtime') + 1]).toBe('runsc');
  });

  it('forwards env vars and cwd', () => {
    const args = buildDockerArgs({
      image: 'alpine',
      command: ['printenv'],
      timeoutMs: 1,
      env: { FOO: 'bar' },
      cwd: '/work',
    });
    expect(args).toContain('-e');
    expect(args).toContain('FOO=bar');
    expect(args).toContain('-w');
    expect(args).toContain('/work');
  });
});

describe('DockerSandbox with MockContainerRuntime', () => {
  it('runs a DockerTool inside the container (bash.run)', async () => {
    const runtime = new MockContainerRuntime(ok);
    const tools = new Map([['bash.run', bashTool({ memoryMb: 128 })]]);
    const sandbox = new DockerSandbox(tools, { defaultImage: 'alpine', runtime });
    const instance = await sandbox.acquire(ownerPolicy('s'));

    const result = await sandbox.execute(instance, 'bash.run', { script: 'echo hello' }, 5000);

    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.command).toEqual(['/bin/sh', '-c', 'echo hello']);
    expect(runtime.calls[0]?.limits?.memoryMb).toBe(128);

    await sandbox.release(instance);
  });

  it('reports non-zero exit as failure with stderr captured', async () => {
    const runtime = new MockContainerRuntime(nonZero);
    const sandbox = new DockerSandbox(new Map([['bash.run', bashTool()]]), {
      defaultImage: 'alpine',
      runtime,
    });
    const instance = await sandbox.acquire(ownerPolicy('s'));
    const result = await sandbox.execute(instance, 'bash.run', { script: 'exit 42' }, 5000);
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-zero exit: 42');
    expect(result.output).toContain('oops');
  });

  it('reports timeout', async () => {
    const runtime = new MockContainerRuntime(timedOut);
    const sandbox = new DockerSandbox(new Map([['bash.run', bashTool()]]), {
      defaultImage: 'alpine',
      runtime,
    });
    const instance = await sandbox.acquire(ownerPolicy('s'));
    const result = await sandbox.execute(instance, 'bash.run', { script: 'sleep 60' }, 10);
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('falls through to in-process for non-DockerTool (e.g. fs.read)', async () => {
    const runtime = new MockContainerRuntime(ok);
    const fs = fsReadTool([tmpdir()]);
    const sandbox = new DockerSandbox(new Map([['fs.read', fs]]), {
      defaultImage: 'alpine',
      runtime,
    });
    const instance = await sandbox.acquire(ownerPolicy('s'));
    const result = await sandbox.execute(instance, 'fs.read', { path: `${tmpdir()}/nope` }, 1000);
    // fs.read returns a toolResult (error in this case since file doesn't exist),
    // but critically the runtime was NOT called.
    expect(runtime.calls).toHaveLength(0);
    expect(result.toolName).toBe('fs.read');
  });

  it('passes gvisorRuntime through to the runtime options', async () => {
    const runtime = new MockContainerRuntime(ok);
    const sandbox = new DockerSandbox(new Map([['bash.run', bashTool()]]), {
      defaultImage: 'alpine',
      runtime,
      gvisorRuntime: 'runsc',
    });
    const instance = await sandbox.acquire(ownerPolicy('s'));
    await sandbox.execute(instance, 'bash.run', { script: 'echo x' }, 5000);
    expect(runtime.calls[0]?.runtime).toBe('runsc');
  });

  it('bashTool refuses to run in-process when used without DockerSandbox', async () => {
    const tool = bashTool();
    const result = await tool.execute(
      { script: 'echo hi' },
      {
        sessionId: 's',
        agentId: 'a',
        traceId: 't',
        signal: new AbortController().signal,
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('refuses in-process');
  });
});
