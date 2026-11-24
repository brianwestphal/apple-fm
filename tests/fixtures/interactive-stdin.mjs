// Exercise the CLI's interactive permission path over controllable test pipes.
Object.defineProperty(process.stdin, 'isTTY', { value: true });
