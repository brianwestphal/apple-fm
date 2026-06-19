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
  let instructions = '';
  let turns = 0;
  let buf = '';
  const handleLine = (line) => {
    if (line.trim() === '') return;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      write({ type: 'error', code: 'badRequest', message: 'malformed session command' });
      return;
    }
    if (cmd.type === 'reset') {
      const seed = Array.isArray(cmd.seed) ? cmd.seed : [];
      instructions = (cmd.system ?? '') + (seed.length > 0 ? ` [seed:${seed.length}]` : '');
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
