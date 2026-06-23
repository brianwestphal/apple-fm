/**
 * Shared output cap for tools (FR-14). The on-device model has a small context
 * window (~4096 tokens), and a tool result is fed back into that same window mid-turn
 * — so an unbounded result (a big file, a real web page, noisy command output)
 * overflows it and the turn fails with `contextWindowExceeded`. Every tool clamps its
 * output through {@link capOutput} to leave room for the system prompt, the
 * conversation, and the model's reply.
 */

/**
 * Max characters of tool output returned to the model (~750 tokens). The on-device
 * window is only ~4096 tokens and the framework also spends some of it on the tool
 * schemas + the system/guidance prompt, so this is deliberately small: at ~6k chars a
 * dense page (Wikipedia) plus 3 tool schemas overran the window and generation failed
 * (`com.apple.tokengeneration Code=10`) — 3k holds. Reliability over completeness;
 * tools that can page (e.g. `read`'s `offset`/`limit`) fetch more deliberately.
 */
export const MAX_TOOL_OUTPUT_CHARS = 3_000;

/** Clamp `text` to the cap, noting how much was dropped. */
export function capOutput(text: string, max: number = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(${String(text.length - max)} more chars truncated)`;
}
