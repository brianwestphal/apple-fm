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
 * Rules are keyed by tool name, or by a finer `tool:keyPrefix` so that allowing one
 * command prefix (e.g. a `bash:git` rule, or `read:/etc`) doesn't allow all of the
 * tool. A keyed rule matches when the call's key *starts with* the rule's prefix.
 */

/** The three policy outcomes for a tool call. */
export type PermissionMode = 'allow' | 'deny' | 'ask';

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

/**
 * Whether a `tool` / `tool:keyPrefix` rule matches a request. A bare tool rule
 * (no colon) matches any call to that tool; a keyed rule matches when the call has a
 * key that starts with the rule's prefix. Rules are split on the *first* colon, so a
 * key that itself contains a colon (a URL, a path) still matches correctly.
 */
function ruleMatches(rule: string, request: PermissionRequest): boolean {
  const colon = rule.indexOf(':');
  if (colon < 0) return rule === request.tool;
  if (rule.slice(0, colon) !== request.tool) return false;
  return request.key !== undefined && request.key.startsWith(rule.slice(colon + 1));
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

  /** Whether any rule in `set` matches the request. */
  private matches(set: Set<string>, request: PermissionRequest): boolean {
    for (const rule of set) if (ruleMatches(rule, request)) return true;
    return false;
  }

  /** The static decision for a request, before any prompt. `deny` wins over `allow`. */
  decide(request: PermissionRequest): PermissionMode {
    if (this.matches(this.deny, request)) return 'deny';
    if (this.matches(this.allow, request)) return 'allow';
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
