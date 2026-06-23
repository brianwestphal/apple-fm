/**
 * A registry of the tools exposed to a session. The extensibility seam for
 * FR-14 / AF-5: a library consumer registers their own {@link Tool}s, the CLI
 * enables built-ins by name. The registry emits the model-facing
 * {@link ToolDefinition}s onto each turn command and dispatches an incoming
 * `tool_call` to the matching tool's `run`.
 */
import type { Tool, ToolContext, ToolDefinition } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  /** Register (or replace) a tool by name. */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /** Whether a tool with this name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Number of registered tools (0 ⇒ no `tools[]` is sent on a turn). */
  get size(): number {
    return this.tools.size;
  }

  /** The model-facing definitions sent to the helper on a turn command. */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  /**
   * Run a tool by name. Throws (with a clear message) if no such tool is
   * registered, so the dispatcher can surface a `tool_error` to the model.
   */
  async run(name: string, args: Record<string, unknown>, ctx: ToolContext = {}): Promise<string> {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new Error(`unknown tool: ${name}`);
    return tool.run(args, ctx);
  }
}
