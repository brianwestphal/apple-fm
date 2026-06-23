/**
 * Types for tool calling (FR-14 / AF-5 phase 1; see docs/9-tool-calling.md).
 *
 * A {@link Tool} is a Node-side capability the on-device model can invoke
 * mid-generation. The model decides *when* to call a tool; the Swift helper runs
 * the framework's tool-call loop and round-trips each invocation back to Node — the
 * tool's `run` executes here, where typed logic, tests, and (phase 2) permission
 * checks live. Only the Node layer ever implements a tool; the helper carries the
 * call across the wire.
 */

/**
 * Context handed to {@link Tool.run}. Intentionally minimal in phase 1; phase 2
 * threads the permission decision and (later) cancellation through here.
 */
export interface ToolContext {
  /** Aborts the in-flight tool when the turn is torn down (reserved; unused in phase 1). */
  signal?: AbortSignal;
}

/**
 * A tool the model can call. `parameters` is a JSON Schema for the call arguments,
 * expressed in the same subset the helper compiles for guided generation (FR-8;
 * see docs/6-guided-generation.md) — it becomes the tool's native `GenerationSchema`
 * so the model can only produce valid arguments.
 */
export interface Tool {
  /** Unique tool name the model references (e.g. `read`). */
  name: string;
  /** What the tool does — shown to the model so it knows when to call it. */
  description: string;
  /** JSON Schema (the guided-generation subset) for the call arguments. */
  parameters: unknown;
  /**
   * Execute the call. `args` is the object the model generated (already validated
   * against `parameters` by the framework). Return the textual result fed back to
   * the model. Throw to signal the call failed — the model is told and may continue.
   */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;

  /**
   * Optional finer-grained permission key for a call (e.g. the file path for `read`,
   * the command for `bash`). Used to scope allow/deny rules and "always" grants
   * below the whole tool (FR-14 phase 2). Omitted ⇒ rules apply at the tool level.
   */
  permissionKey?(args: Record<string, unknown>): string | undefined;

  /** Optional one-line description of a call, shown in the permission prompt. */
  describe?(args: Record<string, unknown>): string;
}

/**
 * The wire shape of a tool sent to the helper on a turn command (`tools[]`). Just
 * the model-facing surface — never the `run` implementation, which stays in Node.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}
