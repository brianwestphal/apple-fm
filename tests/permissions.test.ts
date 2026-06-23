/**
 * Unit tests for the tool permission policy (FR-14 / AF-5 phase 2): the
 * {@link PermissionPolicy} decision matrix + prompt/memory behavior, and the
 * REPL's `readlineAsker` answer parsing. The gate's integration with the live
 * session is covered in `liveSession.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

import { readlineAsker } from '../src/repl.js';
import type { AskOutcome, PermissionRequest } from '../src/tools/index.js';
import { PermissionPolicy } from '../src/tools/index.js';

/** A request for `tool`/`key`, with the rest filled in. */
function req(tool: string, key?: string): PermissionRequest {
  return { tool, key, description: `${tool} ${key ?? ''}`.trim(), args: key !== undefined ? { key } : {} };
}

describe('PermissionPolicy.decide', () => {
  it('falls back to the default (ask) when no rule matches', () => {
    expect(new PermissionPolicy().decide(req('read'))).toBe('ask');
    expect(new PermissionPolicy({ default: 'allow' }).decide(req('read'))).toBe('allow');
  });

  it('allows a tool listed in allow', () => {
    expect(new PermissionPolicy({ allow: ['read'] }).decide(req('read', '/x'))).toBe('allow');
  });

  it('denies a tool listed in deny, and deny wins over allow', () => {
    expect(new PermissionPolicy({ deny: ['bash'] }).decide(req('bash'))).toBe('deny');
    expect(new PermissionPolicy({ allow: ['bash'], deny: ['bash'] }).decide(req('bash'))).toBe('deny');
  });

  it('matches a keyed rule by prefix (tool:keyPrefix)', () => {
    const policy = new PermissionPolicy({ allow: ['bash:git status'] });
    expect(policy.decide(req('bash', 'git status'))).toBe('allow');
    expect(policy.decide(req('bash', 'git status -s'))).toBe('allow'); // prefix
    expect(policy.decide(req('bash', 'rm -rf /'))).toBe('ask'); // different command
  });

  it('a keyed rule does not allow the whole tool', () => {
    const policy = new PermissionPolicy({ allow: ['bash:git'] });
    expect(policy.decide(req('bash', 'git log'))).toBe('allow');
    expect(policy.decide(req('bash', 'curl evil'))).toBe('ask');
    expect(policy.decide(req('bash'))).toBe('ask'); // no key ⇒ keyed rule can't match
  });

  it('a bare tool rule matches regardless of key', () => {
    expect(new PermissionPolicy({ allow: ['read'] }).decide(req('read', '/anything'))).toBe('allow');
  });

  it('splits a rule on the first colon, so a key containing colons still matches', () => {
    const policy = new PermissionPolicy({ allow: ['read:/a'] });
    expect(policy.decide(req('read', '/a:b/c'))).toBe('allow'); // key has a colon
    expect(policy.decide(req('read', '/z'))).toBe('ask');
  });
});

describe('PermissionPolicy.authorize', () => {
  it('runs allow/deny without prompting', async () => {
    const asker = vi.fn();
    await expect(new PermissionPolicy({ allow: ['read'], asker }).authorize(req('read'))).resolves.toBe(true);
    await expect(new PermissionPolicy({ deny: ['read'], asker }).authorize(req('read'))).resolves.toBe(false);
    expect(asker).not.toHaveBeenCalled();
  });

  it('denies an ask when there is no asker (non-interactive)', async () => {
    await expect(new PermissionPolicy().authorize(req('read'))).resolves.toBe(false);
  });

  it('prompts on ask: once allows just this call', async () => {
    const asker = vi.fn((): Promise<AskOutcome> => Promise.resolve('once'));
    const policy = new PermissionPolicy({ asker });
    await expect(policy.authorize(req('read', '/x'))).resolves.toBe(true);
    await expect(policy.authorize(req('read', '/x'))).resolves.toBe(true); // still asks again
    expect(asker).toHaveBeenCalledTimes(2);
  });

  it('prompts on ask: deny refuses', async () => {
    const asker = vi.fn((): Promise<AskOutcome> => Promise.resolve('deny'));
    await expect(new PermissionPolicy({ asker }).authorize(req('read'))).resolves.toBe(false);
  });

  it('remembers an "always" grant for the process lifetime (keyed)', async () => {
    const asker = vi.fn((): Promise<AskOutcome> => Promise.resolve('always'));
    const policy = new PermissionPolicy({ asker });
    await expect(policy.authorize(req('read', '/proj/a'))).resolves.toBe(true);
    // Same key prefix ⇒ no second prompt.
    await expect(policy.authorize(req('read', '/proj/a'))).resolves.toBe(true);
    await expect(policy.authorize(req('read', '/proj/a/b'))).resolves.toBe(true); // prefix extends
    await expect(policy.authorize(req('read', '/other'))).resolves.toBe(true); // re-prompts, also 'always'
    expect(asker).toHaveBeenCalledTimes(2); // /proj/a once, /other once
  });

  it('treats an asker that throws as a denial', async () => {
    const asker = vi.fn(() => Promise.reject(new Error('tty gone')));
    await expect(new PermissionPolicy({ asker }).authorize(req('read'))).resolves.toBe(false);
  });
});

describe('readlineAsker', () => {
  /** A fake readline whose `question` immediately answers with `answer`. */
  function fakeRl(answer: string): Parameters<typeof readlineAsker>[0] {
    return { question: (_q: string, cb: (a: string) => void) => { cb(answer); } } as Parameters<typeof readlineAsker>[0];
  }

  it.each([
    ['y', 'once'],
    ['yes', 'once'],
    ['a', 'always'],
    ['always', 'always'],
    ['Y', 'once'],
    ['', 'deny'],
    ['n', 'deny'],
    ['nonsense', 'deny'],
  ])('maps %j to %j', async (answer, expected) => {
    await expect(readlineAsker(fakeRl(answer))(req('read', '/x'))).resolves.toBe(expected);
  });
});
