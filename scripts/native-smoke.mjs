import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sessionID = randomUUID();
const command = (method, payload = {}) => ({
  protocolVersion: 1, helperSessionId: sessionID, kind: 'command', method, requestId: randomUUID(),
  generation: 1, observationId: null, pid: null, windowId: null,
  issuedAt: Date.now(), deadlineAt: Date.now() + 10_000, payload,
});
const hello = command('hello', { role: 'executor' });
const shutdown = command('shutdown');
const child = spawn(resolve(root, 'resources/native/one-room-helper'), ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
let shutdownSent = false;
child.stdout.setEncoding('utf8').on('data', (chunk) => {
  stdout += chunk;
  if (!shutdownSent && stdout.includes('\n')) {
    shutdownSent = true;
    child.stdin.end(`${JSON.stringify(shutdown)}\n`);
  }
});
child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
child.stdin.on('error', () => {});
const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
const completion = new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolveExit({ code, signal }));
});
child.stdin.write(`${JSON.stringify(hello)}\n`);
try {
  const { code, signal } = await completion;
  assert.equal(code, 0, `helper exit=${code} signal=${signal} stderr=${stderr}`);
  const responses = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  for (const [index, request] of [hello, shutdown].entries()) {
    const response = responses[index];
    for (const key of ['protocolVersion', 'helperSessionId', 'method', 'requestId', 'generation', 'observationId', 'pid', 'windowId']) {
      assert.equal(response[key], request[key], key);
    }
    assert.equal(response.kind, 'result');
    assert.equal(response.status, 'ok');
    assert.ok(Number.isSafeInteger(response.startedAt));
    assert.ok(response.finishedAt >= response.startedAt);
  }
  assert.equal(responses[0].payload.captureStarted, false);
  assert.equal(responses[0].payload.capabilities.windowCapture.supported, true);
  assert.equal(responses[0].payload.capabilities.visionOcr.supported, true);
  assert.ok(responses[0].payload.permissions);
  assert.ok(responses[0].payload.foundationMethods.includes('permissions.request'));
  console.log('Native hello/shutdown smoke passed. No permission requested; no screen content captured.');
} finally {
  clearTimeout(timer);
  if (child.exitCode === null) child.kill('SIGKILL');
}
if (process.argv.includes('--fixture')) await import('../native/tests/fixture-smoke.mjs');
