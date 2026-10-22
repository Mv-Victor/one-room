import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, readFile, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = join(root, 'native/.build/One Room Native Fixture.app');
const executable = join(bundle, 'Contents/MacOS/native-fixture');
await mkdir(dirname(executable), { recursive: true });
await copyFile(join(root, 'native/fixtures/Info.plist'), join(bundle, 'Contents/Info.plist'));
const build = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-target', 'arm64-apple-macos14.0',
  join(root, 'native/fixtures/NativeFixture.swift'), '-o', executable], { stdio: 'inherit' });
assert.equal(build.status, 0, 'fixture build');
const signing = spawnSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'ignore' });
assert.equal(signing.status, 0, 'fixture signing');

class TestSession {
  pending = new Map();
  events = [];
  buffer = '';
  session = randomUUID();
  constructor() {
    this.process = spawn(join(root, 'resources/native/one-room-helper'), ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stdout.setEncoding('utf8').on('data', (chunk) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const value = JSON.parse(line);
        if (value.kind === 'event') this.events.push(value);
        else {
          const task = this.pending.get(value.requestId);
          if (task) { clearTimeout(task.timer); this.pending.delete(value.requestId); task.resolve(value); }
        }
      }
    });
    this.process.stdin.on('error', () => {});
    this.process.stderr.resume();
  }
  request(method, payload = {}, identity = {}) {
    const requestId = randomUUID();
    const request = { protocolVersion: 1, helperSessionId: this.session, requestId, kind: 'command', method,
      generation: 1, observationId: null, pid: null, windowId: null, issuedAt: Date.now(), deadlineAt: Date.now() + 12000,
      payload, ...identity };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 13000);
      this.pending.set(requestId, { timer, resolve, reject });
      this.process.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }
  async close() {
    if (this.process.exitCode === null) {
      try { await this.request('shutdown'); } catch { this.process.kill('SIGKILL'); }
      this.process.stdin.end();
    }
    for (const { timer } of this.pending.values()) clearTimeout(timer);
  }
}

const temporary = await mkdtemp(join(tmpdir(), 'one-room-native-fixture-'));
const stagingRoot = await realpath(temporary);
const fixture = spawn(executable, [], { stdio: ['ignore', 'pipe', 'pipe'] });
fixture.stderr.resume();
const executor = new TestSession();
const listener = new TestSession();
try {
  const ready = await new Promise((resolveReady, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Fixture did not become ready.')), 10000);
    fixture.stdout.setEncoding('utf8').on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) { clearTimeout(timer); resolveReady(JSON.parse(buffer.split('\n')[0])); }
    });
    fixture.once('error', reject);
  });
  const hello = await executor.request('hello', { role: 'executor', stagingRoot });
  assert.equal(hello.status, 'ok');
  const identity = { pid: ready.pid, windowId: ready.windowId, observationId: randomUUID() };
  const preflight = await executor.request('capture.preflight', {}, { ...identity, observationId: null });
  if (preflight.status !== 'ok') console.error(JSON.stringify({ fixtureBlockers: ready.blockers }));
  assert.equal(preflight.status, 'ok', `fixture preflight: ${preflight.error?.code} ${preflight.error?.stage}`);
  const token = randomUUID();
  const capture = await executor.request('capture', { policyRevision: 1, contextRevision: 1, trigger: 'manual', outputToken: token }, identity);
  assert.equal(capture.status, 'ok', `fixture capture: ${capture.error?.code}`);
  const png = await readFile(join(stagingRoot, `${token}.png`));
  assert.equal(createHash('sha256').update(png).digest('hex'), capture.payload.sha256);
  assert.ok(capture.payload.width > 0 && capture.payload.height > 0);
  const ax = await executor.request('extract', { policyRevision: 1, contextRevision: 1 }, identity);
  assert.ok(['ok', 'partial'].includes(ax.status), `fixture AX: ${ax.error?.code}`);
  assert.ok(ax.payload.text.includes('ONE ROOM NATIVE FIXTURE'), `fixture AX text missing (${ax.payload.nodeCount} nodes)`);
  const ocr = await executor.request('ocr', { inputToken: token, languages: ['zh-Hans', 'en-US'] }, identity);
  assert.equal(ocr.status, 'ok', `fixture OCR: ${ocr.error?.code}`);
  assert.match(ocr.payload.text, /ONE ROOM NATIVE FIXTURE/i);
  assert.ok(ocr.payload.text.includes('工作日报'), 'Chinese OCR text missing');
  assert.equal((await listener.request('hello', { role: 'listener' })).status, 'ok');
  assert.equal((await listener.request('observe', { policyRevision: 1, heartbeatMs: 250,
    allowedBundleIds: [ready.bundleId], excludedBundleIds: [], triggers: ['app_switch', 'window_focus', 'window_title', 'content_changed'] })).status, 'ok');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  assert.ok(listener.events.some((event) => event.method === 'window.changed' && event.pid === ready.pid));
  assert.ok(listener.events.some((event) => event.method === 'heartbeat'));
  console.log(JSON.stringify({ status: 'passed', scope: 'isolated native fixture only',
    capture: { width: capture.payload.width, height: capture.payload.height, bytes: png.length, hashVerified: true },
    ax: { characters: ax.payload.text.length, completeness: ax.payload.completeness },
    ocr: { characters: ocr.payload.text.length, chinese: true, english: true },
    listener: { initialWindow: true, heartbeat: true },
    pending: ['second Mac', 'Developer ID / TCC identity', 'real input timing', 'three-finger gestures'] }, null, 2));
} finally {
  await executor.close();
  await listener.close();
  fixture.kill('SIGTERM');
  await rm(temporary, { recursive: true, force: true });
}
