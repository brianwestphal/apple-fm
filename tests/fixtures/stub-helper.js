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
    case 'number':
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
      if (req.stream === true) {
        write({ type: 'error', code: 'badRequest', message: 'streaming is not supported with a schema (structured streaming is not yet implemented)' });
        process.exit(1);
      }
      const err = schemaError(req.schema);
      if (err) {
        write({ type: 'error', code: 'unsupportedSchema', message: err });
        process.exit(1);
      }
      write({ type: 'result', content: JSON.stringify(sampleFromSchema(req.schema)) });
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
} else {
  process.stderr.write('usage: stub-helper --probe | --generate\n');
  process.exit(64);
}
