/**
 * apple-fm — command-line and programmatic access to Apple's on-device
 * Foundation Models (Apple Intelligence) on macOS 26+.
 *
 * The Node layer spawns a small Swift helper that wraps the `FoundationModels`
 * framework and speaks line-delimited JSON. This module is the public API:
 * probe availability, run one-shot (optionally guided/streamed) generations, or
 * drive a multi-turn {@link ChatSession} with automatic context compaction.
 *
 * @example
 * ```ts
 * import { probe, generate, ChatSession } from 'apple-fm';
 *
 * if ((await probe()).available) {
 *   const text = await generate({ prompt: 'Summarize: …' });
 *   const chat = new ChatSession({ system: 'You are concise.' });
 *   await chat.send('Hi');
 * }
 * ```
 *
 * @packageDocumentation
 */
export { generate, HELPER_BIN_ENV, isPlatformSupported, probe, resolveHelperPath } from './helper.js';
export type { ChatBackend, LiveSessionConfig } from './liveSession.js';
export { LiveSession } from './liveSession.js';
export {
  encodeRequest,
  estimateConversationTokens,
  estimateTokens,
  flattenMessages,
  parseEvent,
  splitLines,
} from './protocol.js';
export type { ChatSessionConfig, GenerateFn } from './session.js';
export { ChatSession } from './session.js';
export type { Tool, ToolContext, ToolDefinition } from './tools/index.js';
export { BUILTIN_TOOLS, readTool, registryFromNames, ToolRegistry } from './tools/index.js';
export type {
  DeltaHandler,
  GenerateOptions,
  GenerateRequest,
  HelperEvent,
  HelperOptions,
  Message,
  ProbeResult,
  Role,
  SnapshotHandler,
  UnavailableReason,
} from './types.js';
