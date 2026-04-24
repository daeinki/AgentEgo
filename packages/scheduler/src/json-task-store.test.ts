import { describe, it, expect } from 'vitest';
import { parseTasksJson, stripJson5 } from './json-task-store.js';

describe('stripJson5', () => {
  it('strips line comments but preserves strings containing `//`', () => {
    const input = '{\n  // a line comment\n  "url": "http://x"\n}';
    const out = stripJson5(input);
    expect(out).toContain('"http://x"');
    expect(out).not.toContain('a line comment');
  });

  it('strips block comments', () => {
    const input = '/* header */\n[1, 2]';
    expect(stripJson5(input).trim()).toBe('[1, 2]');
  });

  it('strips trailing commas before } and ]', () => {
    const input = '{ "a": 1, }';
    expect(stripJson5(input)).toBe('{ "a": 1 }');
    const input2 = '[1, 2, 3,]';
    expect(stripJson5(input2)).toBe('[1, 2, 3]');
  });

  it('leaves escaped quotes in strings alone', () => {
    const input = '{ "s": "he said \\"hi\\"" }';
    expect(stripJson5(input)).toBe(input);
  });
});

describe('parseTasksJson', () => {
  it('parses a mix of chat/bash/workflow tasks', () => {
    const text = `[
      {
        // daily summary
        "id": "morning",
        "spec": "0 9 * * *",
        "enabled": true,
        "type": "chat",
        "chat": { "prompt": "지난밤 요약해줘" }
      },
      {
        "id": "backup",
        "spec": "0 3 * * *",
        "enabled": false,
        "type": "bash",
        "bash": { "command": "tar czf /tmp/backup.tgz /data", "timeoutMs": 60000 }
      },
      {
        "id": "etl",
        "spec": "*/15 * * * *",
        "enabled": true,
        "type": "workflow",
        "workflow": { "path": "./etl.json", "initialVars": { "region": "us-east" } }
      },
    ]`;
    const tasks = parseTasksJson(text);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]?.type).toBe('chat');
    if (tasks[0]?.type === 'chat') {
      expect(tasks[0].chat.prompt).toBe('지난밤 요약해줘');
    }
    expect(tasks[1]?.type).toBe('bash');
    if (tasks[1]?.type === 'bash') {
      expect(tasks[1].bash.timeoutMs).toBe(60000);
      expect(tasks[1].enabled).toBe(false);
    }
    expect(tasks[2]?.type).toBe('workflow');
    if (tasks[2]?.type === 'workflow') {
      expect(tasks[2].workflow.initialVars?.['region']).toBe('us-east');
    }
  });

  it('defaults enabled=true when the field is omitted', () => {
    const text = `[{ "id": "x", "spec": "* * * * *", "type": "chat", "chat": { "prompt": "hi" } }]`;
    const tasks = parseTasksJson(text);
    expect(tasks[0]?.enabled).toBe(true);
  });

  it('throws on duplicate task id', () => {
    const text = `[
      { "id": "x", "spec": "* * * * *", "type": "chat", "chat": { "prompt": "a" } },
      { "id": "x", "spec": "* * * * *", "type": "chat", "chat": { "prompt": "b" } }
    ]`;
    expect(() => parseTasksJson(text)).toThrow(/duplicate/);
  });

  it('rejects unknown task type', () => {
    const text = `[{ "id": "x", "spec": "* * * * *", "type": "rocket", "chat": { "prompt": "hi" } }]`;
    expect(() => parseTasksJson(text)).toThrow(/type must be/);
  });

  it('rejects invalid sessionStrategy', () => {
    const text = `[{
      "id": "x", "spec": "* * * * *", "type": "chat",
      "chat": { "prompt": "hi", "sessionStrategy": "weird" }
    }]`;
    expect(() => parseTasksJson(text)).toThrow(/sessionStrategy/);
  });

  it('requires chat.prompt / bash.command / workflow.path', () => {
    expect(() =>
      parseTasksJson(`[{ "id": "x", "spec": "* * * * *", "type": "chat", "chat": {} }]`),
    ).toThrow(/chat.prompt/);
    expect(() =>
      parseTasksJson(`[{ "id": "x", "spec": "* * * * *", "type": "bash", "bash": {} }]`),
    ).toThrow(/bash.command/);
    expect(() =>
      parseTasksJson(`[{ "id": "x", "spec": "* * * * *", "type": "workflow", "workflow": {} }]`),
    ).toThrow(/workflow.path/);
  });

  it('rejects a non-array top level', () => {
    expect(() => parseTasksJson(`{ "tasks": [] }`)).toThrow(/top-level array/);
  });
});
