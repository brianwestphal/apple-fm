#!/usr/bin/env node
/**
 * A stand-in for the Swift `apple-fm-helper`, used so the process layer can be
 * tested without a macOS 26 device or the real on-device model. Speaks the same
 * NDJSON protocol. Behavior is steered by env vars and by the request body.
 *
 *   STUB_UNAVAILABLE=1   --probe reports unavailable
 *   STUB_HANG=1          never exits (to exercise the timeout)
 *
 * For --generate:
 *   prompt === "BOOM"    emit an error event and exit 1
 *   prompt === "NOTREADY" emit a modelNotReady error and exit 1 (model provisioning)
 *   request.schema       native guided generation (see docs/6-guided-generation.md):
 *                          + stream         -> badRequest error
 *                          unsupported      -> unsupportedSchema error
 *                          otherwise        -> result is JSON shaped to the schema
 *   request.stream       emit two delta lines, then a result of "Hello world"
 *   otherwise            result content is the request echoed back as JSON
 */
const args = process.argv.slice(2);
const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// Mirror the Swift helper's strict JSON Schema → GenerationSchema translation:
// returns an error message for an unsupported construct, or null when supported.
function schemaError(schema) {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return 'schema node must be a JSON object';
  }
  if (typeof schema.type !== 'string') {
    return 'schema node is missing a string "type" (oneOf / anyOf / allOf / $ref are not supported)';
  }
  switch (schema.type) {
    case 'object': {
      if (typeof schema.properties !== 'object' || schema.properties === null) {
        return 'object schema is missing "properties"';
      }
      for (const child of Object.values(schema.properties)) {
        const err = schemaError(child);
        if (err) return err;
      }
      return null;
    }
    case 'array': {
      if (typeof schema.items !== 'object' || schema.items === null) {
        return 'array schema is missing "items"';
      }
      return schemaError(schema.items);
    }
    case 'string': {
      if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.some((c) => typeof c !== 'string'))) {
        return 'only string enum values are supported';
      }
      return null;
    }
    case 'integer':
    case 'number': {
      // Numeric minimum/maximum map to a GenerationGuide range; min > max would
      // be an invalid range (mirrors the Swift helper's rejection).
      if (typeof schema.minimum === 'number' && typeof schema.maximum === 'number' && schema.minimum > schema.maximum) {
        return `minimum (${schema.minimum}) is greater than maximum (${schema.maximum})`;
      }
      return null;
    }
    case 'boolean':
      return null;
    default:
      return `unsupported JSON Schema type: ${schema.type}`;
  }
}

// Build a deterministic value conforming to a (supported) schema, standing in for
// the model's guaranteed-structure output.
function sampleFromSchema(schema) {
  switch (schema.type) {
    case 'object': {
      const out = {};
      for (const [key, child] of Object.entries(schema.properties ?? {})) out[key] = sampleFromSchema(child);
      return out;
    }
    case 'array':
      return [sampleFromSchema(schema.items)];
    case 'string':
      return Array.isArray(schema.enum) ? schema.enum[0] : 'string';
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

if (process.env.STUB_HANG === '1') {
  setInterval(() => undefined, 1000);
} else if (args.includes('--probe')) {
  if (process.env.STUB_UNAVAILABLE === '1') {
    process.stdout.write(JSON.stringify({ available: false, reason: 'appleIntelligenceNotEnabled' }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ available: true }) + '\n');
  }
  process.exit(0);
} else if (args.includes('--generate')) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    const req = JSON.parse(input);
    if (req.prompt === 'BOOM') {
      write({ type: 'error', code: 'inferenceFailed', message: 'boom' });
      process.exit(1);
    }
    if (req.prompt === 'NOTREADY') {
      // Mirrors the Swift helper mapping ModelManagerError 1008 → modelNotReady.
      write({ type: 'error', code: 'modelNotReady', message: 'the on-device model is still provisioning; try again shortly' });
      process.exit(1);
    }
    if (req.prompt === 'STDERR_FAIL') {
      // Nonzero exit with raw stderr and NO error event — exercises helper.ts's
      // stderr-surfacing branch (the helper crashed before emitting a wire error).
      process.stderr.write('helper diagnostic: model subsystem offline');
      process.exit(2);
    }
    if (req.schema !== undefined) {
      const err = schemaError(req.schema);
      if (err) {
        write({ type: 'error', code: 'unsupportedSchema', message: err });
        process.exit(1);
      }
      const full = JSON.stringify(sampleFromSchema(req.schema));
      if (req.stream === true) {
        // Structured streaming: full partial snapshots (replace), then the result.
        write({ type: 'snapshot', content: '{}' });
        write({ type: 'snapshot', content: full });
        write({ type: 'result', content: full });
      } else {
        write({ type: 'result', content: full });
      }
      process.exit(0);
    }
    if (req.stream === true) {
      write({ type: 'delta', text: 'Hello ' });
      write({ type: 'delta', text: 'world' });
      write({ type: 'result', content: 'Hello world' });
    } else {
      write({ type: 'result', content: JSON.stringify(req) });
    }
    process.exit(0);
  });
} else if (args.includes('--session')) {
  // Persistent live session: one command per stdin line, processed serially.
  // Holds in-memory "context" (instructions from the last reset + a turn count)
  // so tests can assert KV-cache continuity and that reset clears it. Special turn
  // prompts drive the error / crash paths:
  //   BOOM      -> per-turn error (loop continues)
  //   OVERFLOW  -> per-turn contextWindowExceeded error
  //   CRASH     -> exit(1) abruptly (process death)
  //   TOOL <name> <jsonArgs> -> emit a tool_call (mirrors the Swift DynamicTool
  //                  suspend/resume): pause the turn, await a tool_result /
  //                  tool_error command, then emit the final result / error.
  let instructions = '';
  let turns = 0;
  let buf = '';
  // Tool names offered at the last reset (the framework binds tools at session
  // construction, so they ride on `reset`, not each turn).
  let offeredTools = [];
  // callId -> turn id, for tool calls awaiting their tool_result/tool_error.
  const pendingTools = new Map();
  // id -> partial text, for streaming turns awaiting a `cancel` (esc-to-interrupt,
  // FR-15): the turn emits a delta then waits, and a cancel ends it with the partial.
  const pendingCancel = new Map();
  const handleLine = (line) => {
    if (line.trim() === '') return;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      write({ type: 'error', code: 'badRequest', message: 'malformed session command' });
      return;
    }
    // Node -> helper tool outcomes resume a paused turn (matched by callId).
    if (cmd.type === 'tool_result' || cmd.type === 'tool_error') {
      const id = pendingTools.get(cmd.callId);
      if (id === undefined) return;
      pendingTools.delete(cmd.callId);
      if (cmd.type === 'tool_result') {
        turns += 1;
        write({ type: 'result', id, content: String(cmd.content) });
      } else {
        write({ type: 'error', id, code: 'toolFailed', message: String(cmd.message) });
      }
      return;
    }
    // Interrupt an in-flight streaming turn (FR-15): end it with its partial text,
    // mirroring the Swift helper emitting a `result` on cancellation.
    if (cmd.type === 'cancel') {
      if (pendingCancel.has(cmd.id)) {
        const partial = pendingCancel.get(cmd.id);
        pendingCancel.delete(cmd.id);
        turns += 1;
        write({ type: 'result', id: cmd.id, content: partial });
      }
      return;
    }
    if (cmd.type === 'reset') {
      const seed = Array.isArray(cmd.seed) ? cmd.seed : [];
      instructions = (cmd.system ?? '') + (seed.length > 0 ? ` [seed:${seed.length}]` : '');
      offeredTools = Array.isArray(cmd.tools) ? cmd.tools.map((t) => t && t.name).filter(Boolean) : [];
      turns = 0;
      write({ type: 'ready', id: cmd.id });
      return;
    }
    const prompt = cmd.prompt ?? '';
    if (prompt === 'BOOM') {
      write({ type: 'error', id: cmd.id, code: 'inferenceFailed', message: 'boom' });
      return;
    }
    if (prompt === 'OVERFLOW') {
      write({ type: 'error', id: cmd.id, code: 'contextWindowExceeded', message: 'overflow' });
      return;
    }
    if (prompt === 'CRASH') process.exit(1);
    if (prompt === 'STREAM_FOREVER') {
      // Stream one delta, then keep the turn open until a `cancel` finishes it with
      // the partial — lets tests exercise esc-to-interrupt deterministically.
      write({ type: 'delta', id: cmd.id, text: 'partial ' });
      pendingCancel.set(cmd.id, 'partial ');
      return;
    }
    const toolMatch = /^TOOL (\S+) (.*)$/.exec(prompt);
    if (toolMatch) {
      // Only call a tool the turn actually offered (mirrors the helper building the
      // session with exactly the turn's `tools[]`).
      const [, name, argsJson] = toolMatch;
      const offered = offeredTools.includes(name);
      if (!offered) {
        write({ type: 'error', id: cmd.id, code: 'inferenceFailed', message: `tool ${name} not offered` });
        return;
      }
      const callId = `${cmd.id}:1`;
      pendingTools.set(callId, cmd.id);
      let args;
      try {
        args = JSON.parse(argsJson);
      } catch {
        args = {};
      }
      write({ type: 'tool_call', id: cmd.id, callId, name, arguments: args });
      return; // turn stays open until the tool_result/tool_error arrives
    }
    if (prompt === 'JUNK') {
      // Exercise the demux's defensive branches, then resolve normally.
      process.stdout.write('not json\n'); // malformed -> JSON.parse throws
      process.stdout.write('5\n'); // valid JSON but not an object
      write({ type: 'result', content: 'no id' }); // missing id
      write({ type: 'result', id: 'no-such-id', content: 'stale' }); // unknown id
      write({ type: 'mystery', id: cmd.id }); // unknown event type
      write({ type: 'result', id: cmd.id, content: JSON.stringify({ ok: true }) });
      return;
    }
    turns += 1;
    if (cmd.stream === true) {
      write({ type: 'delta', id: cmd.id, text: 'Hello ' });
      write({ type: 'delta', id: cmd.id, text: 'world' });
      write({ type: 'result', id: cmd.id, content: 'Hello world' });
      return;
    }
    write({ type: 'result', id: cmd.id, content: JSON.stringify({ instructions, turns, prompt }) });
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      handleLine(line);
    }
  });
  process.stdin.on('end', () => {
    if (buf.trim() !== '') handleLine(buf);
    process.exit(0);
  });
} else {
  process.stderr.write('usage: stub-helper --probe | --generate | --session\n');
  process.exit(64);
}
