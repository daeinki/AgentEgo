import type { ToolDefinition } from './types.js';

/**
 * OpenAI (`^[a-zA-Z0-9_-]+$`) and Anthropic (`^[a-zA-Z0-9_-]{1,64}$`) both
 * reject tool names containing `.`, which is our canonical convention
 * (`fs.read`, `skill.create`, etc.). We transparently rewrite wire-side
 * names and translate them back when a tool_call arrives.
 */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Build a bidirectional sanitize ↔ canonical map for a single completion
 * request. Detects collisions — if two canonical names normalize to the
 * same wire name (e.g., `a.b` and `a_b`), throws so the caller notices
 * rather than silently routing a tool_call to the wrong implementation.
 */
export function buildToolNameMap(tools: ToolDefinition[]): {
  /** Maps wire (sanitized) name → canonical tool name. */
  wireToCanonical: Map<string, string>;
  /** Rewritten tool list safe to send to the provider API. */
  wireTools: ToolDefinition[];
} {
  const wireToCanonical = new Map<string, string>();
  const wireTools: ToolDefinition[] = [];
  for (const t of tools) {
    const wire = sanitizeToolName(t.name);
    const collision = wireToCanonical.get(wire);
    if (collision !== undefined && collision !== t.name) {
      throw new Error(
        `tool name collision after sanitization: "${collision}" and "${t.name}" both normalize to "${wire}"`,
      );
    }
    wireToCanonical.set(wire, t.name);
    wireTools.push({ ...t, name: wire });
  }
  return { wireToCanonical, wireTools };
}
