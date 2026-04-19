import type { Contracts } from '@agent-platform/core';
import type { AgentTool } from './types.js';

/**
 * U10 Phase 4: mutable, single-source-of-truth tool registry.
 *
 * Wraps a `Map<string, AgentTool>` that the rest of the platform (sandbox,
 * capability guard, agent-runner) holds a live reference to. Registering a
 * new tool at runtime — for example, after `skill.create` installs a new
 * skill — becomes visible to every live holder without any reconnection
 * dance.
 *
 * Intended wiring:
 *   const registry = new LiveToolRegistry(initialTools);
 *   const toolMap = registry.asMap();
 *   new InProcessSandbox(toolMap);        // keeps live ref
 *   new PolicyCapabilityGuard(.., toolMap);
 *   // AgentRunner: pass `toolRegistry: registry` — processTurn() snapshots
 *   // descriptors() each turn, so newly-registered tools become part of
 *   // availableTools on the *next* turn.
 *
 * Note: this is NOT a re-implementation of SkillRegistry (which is about
 * disk-resident skill packages). This is the in-memory mirror that
 * skill-tools consults via the `remount` callback.
 */
export class LiveToolRegistry {
  private readonly map = new Map<string, AgentTool>();

  constructor(initial: AgentTool[] = []) {
    for (const t of initial) this.map.set(t.name, t);
  }

  /** Live reference — mutations are visible to anyone holding this. */
  asMap(): Map<string, AgentTool> {
    return this.map;
  }

  /** Snapshot of currently-registered tools (cheap — array iteration). */
  snapshot(): AgentTool[] {
    return [...this.map.values()];
  }

  /** Descriptor list suitable for `ReasoningContext.availableTools`. */
  descriptors(): Contracts.ToolDescriptor[] {
    return this.snapshot().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  register(tool: AgentTool): void {
    this.map.set(tool.name, tool);
  }

  /**
   * Register multiple tools; existing entries with the same name are
   * overwritten. Intended for the skill-remount path.
   */
  registerAll(tools: AgentTool[]): void {
    for (const t of tools) this.map.set(t.name, t);
  }

  unregister(name: string): boolean {
    return this.map.delete(name);
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  get(name: string): AgentTool | undefined {
    return this.map.get(name);
  }

  /**
   * Replace the entire tool set atomically. Used when a fresh re-scan of the
   * skill install directory supersedes all previously-mounted skill tools.
   * Tools outside `keep` set can be preserved by listing their names.
   *
   * When `preserveNames` is provided, any current entries whose `name` is in
   * the set are kept; everything else is cleared before `next` is loaded.
   */
  replace(next: AgentTool[], preserveNames?: Set<string>): void {
    if (preserveNames) {
      for (const name of [...this.map.keys()]) {
        if (!preserveNames.has(name)) this.map.delete(name);
      }
    } else {
      this.map.clear();
    }
    for (const t of next) this.map.set(t.name, t);
  }

  get size(): number {
    return this.map.size;
  }
}
