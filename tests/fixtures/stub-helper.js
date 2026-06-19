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
 *   request.stream       emit two delta lines, then a result of "Hello world"
 *   otherwise            result content is the request echoed back as JSON
 */
const args = process.argv.slice(2);
const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

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
