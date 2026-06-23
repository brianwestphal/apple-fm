/**
 * Tool calling surface (FR-14 / AF-5; see docs/9-tool-calling.md). Re-exports the
 * {@link Tool} contract, the {@link ToolRegistry}, and the built-in tools, plus a
 * helper to build a registry from built-in names (used by the CLI's `--tools`).
 */
import { bashTool } from './builtin/bash.js';
import { readTool } from './builtin/read.js';
import { webTool } from './builtin/web.js';
import { ToolRegistry } from './registry.js';
import type { Tool } from './types.js';

export { bashTool } from './builtin/bash.js';
export { readTool } from './builtin/read.js';
export { webTool } from './builtin/web.js';
export type {
  AskOutcome,
  PermissionAsker,
  PermissionMode,
  PermissionPolicyConfig,
  PermissionRequest,
} from './permissions.js';
export { PermissionPolicy } from './permissions.js';
export { ToolRegistry } from './registry.js';
export type { Tool, ToolContext, ToolDefinition } from './types.js';

/** The built-in tools, keyed by name. `web` is the only networked one (off by default). */
export const BUILTIN_TOOLS: Readonly<Record<string, Tool>> = { read: readTool, bash: bashTool, web: webTool };

/**
 * Build a registry from built-in tool names (e.g. the CLI's `--tools read`).
 * Throws on an unknown name so a typo is a clear error rather than a silent no-op.
 */
export function registryFromNames(names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) {
    const tool = BUILTIN_TOOLS[name];
    if (tool === undefined) {
      throw new Error(`unknown built-in tool "${name}" (available: ${Object.keys(BUILTIN_TOOLS).join(', ')})`);
    }
    registry.register(tool);
  }
  return registry;
}
