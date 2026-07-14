/**
 * Per-call permission policy for tool calling (FR-14 / AF-5 phase 2; see
 * docs/10-permissions.md). Consulted by the live-session dispatcher *before* a
 * tool runs. Kept entirely in Node — the Swift helper never decides policy.
 *
 * A request resolves to `allow` / `deny` / `ask`. `ask` prompts via an injected
 * {@link PermissionAsker} (the REPL supplies one bound to readline); with no asker
 * (non-interactive / piped), `ask` denies — a script never silently runs a tool. An
 * "always" answer is remembered for the process lifetime.
 *
 * Rules are keyed by tool name, or by a finer `tool:key` so that allowing one
 * command (a `bash:git status` rule) or one path (`read:/etc`) doesn't allow all of
 * the tool. How a keyed rule's key matches a call's key is decided by the tool's
 * {@link Tool.matchKey} — **exact equality** by default (never a prefix, so a grant
 * can't be extended with shell metacharacters or `..`), `read` widening it to a
 * resolved path boundary, `bash` keeping `allow` exact but making `deny` a broad
 * best-effort token match (AFM-63 / AFM-67). A permissive *default* never
 * blanket-approves a {@link Tool.dangerous} tool (AFM-64).
 */

/** The three policy outcomes for a tool call. */
export type PermissionMode = 'allow' | 'deny' | 'ask';

/** Which rule set a match is being tested against (tools may match differently). */
export type RuleKind = 'allow' | 'deny';

/** How a tool's key is compared to a rule's key. Defaults to exact equality. */
export type KeyMatcher = (ruleKey: string, callKey: string, kind: RuleKind) => boolean;

/** Longest description shown in a permission prompt before it is elided (AFM-68). */
const MAX_PROMPT_DESCRIPTION = 200;

/**
 * Make a model-controlled description safe to render in the interactive approval
 * prompt (AFM-68). The command/path shown to the user is attacker-controlled, and the
 * gate's whole value is informed consent — so strip ANSI escapes and control
 * characters (which could rewrite the line, hide the real command, or scroll it
 * off-screen) to a single line, and cap the length. Applied at the render site so it
 * covers every tool's `describe`, not just the built-ins.
 */
export function sanitizeForPrompt(text: string): string {
  const stripped = text
    // ANSI CSI sequences (colors, cursor moves, line erase): ESC "[" … final byte.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // Any remaining control characters (incl. \r \n \t and a bare ESC) -> a space.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim();
  if (stripped.length <= MAX_PROMPT_DESCRIPTION) return stripped;
  return `${stripped.slice(0, MAX_PROMPT_DESCRIPTION)}… (${String(stripped.length - MAX_PROMPT_DESCRIPTION)} more chars)`;
}

/** What the user chose at an interactive prompt. */
export type AskOutcome = 'once' | 'always' | 'deny';

/** A pending tool call presented to the policy (and the prompt). */
export interface PermissionRequest {
  /** The tool name. */
  tool: string;
  /** A finer-grained key for this call (e.g. the path/command), if the tool gives one. */
  key?: string;
  /** One-line, human-readable description of the action (shown in the prompt). */
  description: string;
  /** The raw arguments the model generated. */
  args: Record<string, unknown>;
  /**
   * How this tool compares a rule's key to {@link key} (from `Tool.matchKey`). Omitted
   * ⇒ exact equality — a keyed rule matches only the identical key, never a prefix.
   */
  matchKey?: KeyMatcher;
  /** High-risk tool (`Tool.dangerous`): a permissive default won't blanket-approve it. */
  dangerous?: boolean;
}

/** Prompts the user to approve a call; the REPL provides this on a TTY. */
export type PermissionAsker = (request: PermissionRequest) => Promise<AskOutcome>;

/** Construction options for a {@link PermissionPolicy}. */
export interface PermissionPolicyConfig {
  /** Decision when no rule matches (default `ask`). */
  default?: PermissionMode;
  /** Pre-authorized rules (`tool` or `tool:keyPrefix`), e.g. from `--allow-tool`. */
  allow?: string[];
  /** Denied rules (`tool` or `tool:keyPrefix`), e.g. from `--deny-tool`. */
  deny?: string[];
  /** Prompt on `ask`. Omitted ⇒ non-interactive: `ask` denies. */
  asker?: PermissionAsker;
}

/** Default key comparison when a tool defines no `matchKey`: exact equality (safe). */
const exactKeyMatch: KeyMatcher = (ruleKey, callKey) => ruleKey === callKey;

/**
 * Whether a `tool` / `tool:key` rule matches a request, for the given rule kind. A
 * bare tool rule (no colon) matches any call to that tool; a keyed rule matches when
 * the call has a key and the tool's key matcher (exact by default) accepts the rule's
 * key against it. Rules are split on the *first* colon, so a key that itself contains
 * a colon (a URL, a path) still matches correctly.
 */
function ruleMatches(rule: string, request: PermissionRequest, kind: RuleKind): boolean {
  const colon = rule.indexOf(':');
  if (colon < 0) return rule === request.tool;
  if (rule.slice(0, colon) !== request.tool) return false;
  if (request.key === undefined) return false;
  return (request.matchKey ?? exactKeyMatch)(rule.slice(colon + 1), request.key, kind);
}

export class PermissionPolicy {
  private readonly defaultMode: PermissionMode;
  private readonly allow: Set<string>;
  private readonly deny: Set<string>;
  private readonly asker: PermissionAsker | undefined;

  constructor(config: PermissionPolicyConfig = {}) {
    this.defaultMode = config.default ?? 'ask';
    this.allow = new Set(config.allow ?? []);
    this.deny = new Set(config.deny ?? []);
    this.asker = config.asker;
  }

  /** Whether any rule in `set` matches the request, evaluated as the given kind. */
  private matches(set: Set<string>, request: PermissionRequest, kind: RuleKind): boolean {
    for (const rule of set) if (ruleMatches(rule, request, kind)) return true;
    return false;
  }

  /**
   * The static decision for a request, before any prompt. `deny` wins over `allow`. A
   * permissive *default* (`allow`, e.g. `--yes`) does **not** cover a `dangerous` tool:
   * it downgrades to `ask` so a blanket approval can't silently grant `bash` arbitrary
   * command execution (AFM-64). An explicit allow rule still grants it.
   */
  decide(request: PermissionRequest): PermissionMode {
    if (this.matches(this.deny, request, 'deny')) return 'deny';
    if (this.matches(this.allow, request, 'allow')) return 'allow';
    if (this.defaultMode === 'allow' && request.dangerous === true) return 'ask';
    return this.defaultMode;
  }

  /** Remember an "always" approval for this call (process lifetime). */
  private remember(request: PermissionRequest): void {
    this.allow.add(request.key !== undefined ? `${request.tool}:${request.key}` : request.tool);
  }

  /**
   * Decide whether a call may proceed, prompting on `ask` and remembering an
   * "always". Resolves `true` to run the tool, `false` to refuse it (the dispatcher
   * feeds a refusal back to the model as a tool result). Never throws — an asker that
   * rejects is treated as a denial.
   */
  async authorize(request: PermissionRequest): Promise<boolean> {
    const mode = this.decide(request);
    if (mode === 'allow') return true;
    if (mode === 'deny') return false;
    if (this.asker === undefined) return false; // non-interactive ⇒ deny
    let outcome: AskOutcome;
    try {
      outcome = await this.asker(request);
    } catch {
      return false;
    }
    if (outcome === 'always') {
      this.remember(request);
      return true;
    }
    return outcome === 'once';
  }
}
