/**
 * Dispatch one model `tool_call` (FR-14): run the named tool — after the permission
 * gate — and write the outcome back to the helper as a `tool_result` keyed by its
 * `callId`. Extracted from `LiveSession` (AFM-46) so the wire/process glue stays in
 * `liveSession.ts` and the tool-running policy lives next to the registry it drives.
 *
 * A refusal or failure is fed back as the tool's *result* (a message the model
 * reads), **not** a throwing `tool_error`: on-device, a thrown tool error aborts the
 * whole turn rather than letting the model continue without the tool (verified). See
 * docs/9-tool-calling.md.
 */
import type { PermissionPolicy } from './permissions.js';
import type { ToolRegistry } from './registry.js';

/** Collaborators the dispatcher needs from the owning live session. */
export interface ToolCallDeps {
  /** Tools the model may call (undefined ⇒ none registered). */
  tools: ToolRegistry | undefined;
  /** Permission policy consulted before a tool runs (undefined ⇒ no gate). */
  permission: PermissionPolicy | undefined;
  /** Send a command line back to the helper (the `callId` is added by the caller). */
  send: (command: Record<string, unknown>) => void;
  /** Keep the in-flight turn alive while a (possibly slow) tool / prompt runs. */
  keepAlive: () => void;
}

/**
 * Service a `tool_call` event. Always resolves — every failure/denial path writes a
 * `tool_result` so the suspended turn resumes and the model continues. A malformed
 * event (missing `callId`/`name`) is ignored.
 */
export async function dispatchToolCall(event: Record<string, unknown>, deps: ToolCallDeps): Promise<void> {
  const callId = typeof event.callId === 'string' ? event.callId : undefined;
  const name = typeof event.name === 'string' ? event.name : undefined;
  const args =
    typeof event.arguments === 'object' && event.arguments !== null
      ? (event.arguments as Record<string, unknown>)
      : {};
  if (callId === undefined || name === undefined) return; // malformed; ignore

  // Hold the turn open while the tool (and any permission prompt) runs.
  deps.keepAlive();
  const reply = (command: Record<string, unknown>): void => {
    deps.keepAlive();
    deps.send({ ...command, callId });
  };

  const registry = deps.tools;
  if (registry === undefined || !registry.has(name)) {
    reply({ type: 'tool_result', content: `Unknown tool "${name}".` });
    return;
  }
  // Permission gate (phase 2): refuse → tell the model it was denied; it continues.
  if (deps.permission !== undefined) {
    const request = registry.permissionRequest(name, args);
    const allowed = request !== undefined && (await deps.permission.authorize(request));
    if (!allowed) {
      reply({ type: 'tool_result', content: `Permission to use the "${name}" tool was denied by the user.` });
      return;
    }
  }
  try {
    reply({ type: 'tool_result', content: await registry.run(name, args) });
  } catch (error) {
    reply({ type: 'tool_result', content: `The "${name}" tool failed: ${error instanceof Error ? error.message : String(error)}` });
  }
}
