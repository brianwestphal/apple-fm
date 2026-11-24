/**
 * Unit tests for the extracted tool-call dispatcher (AFM-46). These cover branches
 * the `LiveSession` integration tests don't reach directly (e.g. an unknown tool,
 * where the stub helper would otherwise guard offered-tools first), keeping
 * `src/tools/dispatch.ts` honest in isolation.
 */
import { describe, expect, it, vi } from 'vitest';

import { dispatchToolCall } from '../src/tools/dispatch.js';
import { PermissionPolicy, type Tool, ToolRegistry } from '../src/tools/index.js';

/** A registry with one echo tool, plus a `sent` recorder for the deps. */
function harness(tool?: Tool) {
  const sent: Array<Record<string, unknown>> = [];
  const deps = {
    tools: tool !== undefined ? new ToolRegistry([tool]) : undefined,
    permission: undefined,
    send: (command: Record<string, unknown>) => sent.push(command),
  };
  return { sent, deps };
}

const echoTool: Tool = {
  name: 'echo',
  description: 'echoes',
  parameters: { type: 'object', properties: { v: { type: 'string' } } },
  run: (args) => Promise.resolve(`echo:${String(args.v)}`),
};

describe('dispatchToolCall', () => {
  it('ignores a malformed event (no callId / name) without sending', async () => {
    const { sent, deps } = harness(echoTool);
    await dispatchToolCall({ name: 'echo' }, deps); // missing callId
    await dispatchToolCall({ callId: '1:1' }, deps); // missing name
    expect(sent).toEqual([]);
  });

  it('replies "Unknown tool" when the tool is not registered', async () => {
    const { sent, deps } = harness(); // no registry at all
    await dispatchToolCall({ callId: '1:1', name: 'nope', arguments: {} }, deps);
    expect(sent).toEqual([{ type: 'tool_result', content: 'Unknown tool "nope".', callId: '1:1' }]);
  });

  it('runs the tool and replies with its result (callId echoed)', async () => {
    const { sent, deps } = harness(echoTool);
    await dispatchToolCall({ callId: '2:1', name: 'echo', arguments: { v: 'hi' } }, deps);
    expect(sent).toEqual([{ type: 'tool_result', content: 'echo:hi', callId: '2:1' }]);
  });

  it('feeds a tool failure back as a result (not thrown)', async () => {
    const boom: Tool = { ...echoTool, run: () => Promise.reject(new Error('kaboom')) };
    const { sent, deps } = harness(boom);
    await dispatchToolCall({ callId: '3:1', name: 'echo', arguments: {} }, deps);
    expect(sent[0]).toMatchObject({ type: 'tool_result', callId: '3:1' });
    expect(String(sent[0]?.content)).toMatch(/The "echo" tool failed: kaboom/);
  });

  it('refuses a denied call without running the tool', async () => {
    const run = vi.fn(() => Promise.resolve('ran'));
    const { sent, deps } = harness({ ...echoTool, run });
    const denied = { ...deps, permission: new PermissionPolicy({ deny: ['echo'] }) };
    await dispatchToolCall({ callId: '4:1', name: 'echo', arguments: {} }, denied);
    expect(run).not.toHaveBeenCalled();
    expect(String(sent[0]?.content)).toMatch(/denied by the user/);
  });

  it('drops a pending approval after its original turn ends (AFM-KP3NY0)', async () => {
    const run = vi.fn(() => Promise.resolve('ran'));
    const { sent, deps } = harness({ ...echoTool, run });
    let active = true;
    const permission = new PermissionPolicy({ asker: () => {
      active = false;
      return Promise.resolve('always');
    } });
    await dispatchToolCall({ callId: '5:1', name: 'echo' }, { ...deps, permission, isCurrent: () => active });
    expect(run).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(permission.decide({ tool: 'echo', description: 'echo', args: {} })).toBe('ask');
  });

  it('runs the tool that was looked up before an asynchronous approval (AFM-17X7T9)', async () => {
    const { sent, deps } = harness(echoTool);
    const replacement = vi.fn(() => Promise.resolve('replacement'));
    const permission = new PermissionPolicy({ asker: () => {
      deps.tools?.register({ ...echoTool, run: replacement });
      return Promise.resolve('once');
    } });
    await dispatchToolCall({ callId: '6:1', name: 'echo', arguments: { v: 'old' } }, { ...deps, permission });
    expect(sent).toEqual([{ type: 'tool_result', callId: '6:1', content: 'echo:old' }]);
    expect(replacement).not.toHaveBeenCalled();
  });

  it('fails closed with a bounded result when a permission hook throws (AFM-17X7T9)', async () => {
    const run = vi.fn(() => Promise.resolve('ran'));
    const { sent, deps } = harness({
      ...echoTool,
      run,
      permissionKey: () => 'key',
      matchKey: () => { throw new Error('private data'.repeat(300)); },
    });
    const permission = new PermissionPolicy({ allow: ['echo:key'] });
    await dispatchToolCall({ callId: '7:1', name: 'echo' }, { ...deps, permission });
    expect(run).not.toHaveBeenCalled();
    expect(sent).toEqual([{ type: 'tool_result', callId: '7:1', content: 'The tool could not be authorized.' }]);
  });
});
