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
 * A short system-prompt preamble telling the model it has tools and should use them
 * rather than refuse — built from the registry's enabled tools. The CLI injects this
 * when `--tools` is set (merged with any `-s`) so the small on-device model knows
 * *when* to call a tool instead of falling back on a "can't access files" refusal.
 * Returns `''` for an empty registry. (Library consumers can use it too; the library
 * itself stays unopinionated.)
 */
export function toolGuidancePrompt(registry: ToolRegistry): string {
  const hints = registry.usageHints();
  if (hints.length === 0) return '';
  const intro =
    'You have tools available and the user has authorized their use — every call is ' +
    'permission-checked, so you do not need to ask first. Prefer calling a tool over ' +
    'refusing: never claim you cannot read files, run commands, or access the web — ' +
    'call the matching tool instead. Match the task to the tool: a local file path → read; ' +
    'an http/https URL → web; a shell command → bash. Anything that starts with http:// ' +
    'or https:// is a URL — to read, open, fetch, or summarize it, call web (NOT read, ' +
    'which is local files only, and NOT bash/curl). Call ONE tool for the job, not several ' +
    'for the same thing. Do not use bash to read files or fetch URLs, and never invent a ' +
    'tool or write a tool call as plain text. Available tools:';
  return [intro, ...hints.map((hint) => `- ${hint}`)].join('\n');
}

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
