import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';
import { _electron as electron } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resources = join(root, 'release/mac-arm64/One Room.app/Contents/Resources');
const executablePath = join(root, 'release/mac-arm64/One Room.app/Contents/MacOS/One Room');
const archivePath = join(resources, 'app.asar');
const checks = [];
const helperChildren = new Set();
const pageErrors = [];
let mainDiagnostics = '';
const apiKey = `one-room-package-smoke-${randomUUID()}`;
let userData;
let application;
let blockedRendererRequests = 0;

async function bounded(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'close');
  child.kill('SIGKILL');
  await bounded(stopped, 5_000, 'The isolated test process did not exit.');
}

async function closeApplication() {
  const active = application;
  application = undefined;
  if (!active) return;
  const child = active.process();
  try { await bounded(active.close(), 10_000, 'Packaged application shutdown timed out.'); }
  finally { await stopChild(child); }
}

async function cleanup() {
  try { await closeApplication(); }
  finally {
    await Promise.all([...helperChildren].map(stopChild));
    if (userData) await rm(userData, { recursive: true, force: true });
  }
}

async function inspectArchive() {
  await access(executablePath, constants.X_OK);
  const appPath = resolve(resources, '../..');
  const signature = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], { encoding: 'utf8' });
  assert.equal(signature.status, 0, `Invalid application signature: ${signature.stderr}`);
  const identity = spawnSync('codesign', ['-dvv', appPath], { encoding: 'utf8' });
  assert.equal(identity.status, 0, identity.stderr);
  assert.match(identity.stderr, /^Identifier=local\.one-room\.desktop$/m);
  assert.doesNotMatch(identity.stderr, /Info\.plist=not bound/);
  checks.push('complete application signature verifies and binds the One Room bundle identity');
  const paths = listPackage(archivePath).map(path => path.replace(/^\//, ''));
  for (const path of ['out/main/app.js', 'out/main/database.js', 'out/preload/index.cjs', 'out/renderer/index.html', 'package.json', 'THIRD_PARTY_NOTICES.md']) {
    assert.ok(paths.includes(path), `Missing packaged entry: ${path}`);
  }
  for (const path of ['node_modules/bindings/bindings.js', 'node_modules/file-uri-to-path/index.js', 'node_modules/scheduler/index.js', 'node_modules/loose-envify/index.js']) {
    assert.ok(paths.includes(path), `Missing packaged runtime dependency: ${path}. Package from a local node_modules directory, not a symlink.`);
  }
  const testEntries = paths.filter(path => /^out\/main\/[^/]*(?:smoke|benchmark)[^/]*\.(?:[cm]?js|map)$/i.test(path));
  assert.deepEqual(testEntries, [], 'Test and navigationBenchmark entries must be excluded from ASAR.');
  assert.equal(paths.some(path => !path.startsWith('node_modules/') && /(?:^|\/)(?:tests?|fixtures)(?:\/|$)/i.test(path)), false, 'Project test fixture directories must be excluded from ASAR.');
  const rendererScripts = paths.filter(path => /^out\/renderer\/.*\.(?:[cm]?js|html|map)$/.test(path));
  for (const path of rendererScripts) {
    assert.equal(/fixture/i.test(path), false, `Renderer fixture chunk found: ${path}`);
    const source = extractFile(archivePath, path).toString('utf8');
    for (const marker of ['isolated-worklog-fixture', '0.1.0-fixture', 'createFixtureApi', 'createFixtureSnapshot']) {
      assert.equal(source.includes(marker), false, `Renderer contains development fixture code (${marker}): ${path}`);
    }
  }
  assert.deepEqual(extractFile(archivePath, 'THIRD_PARTY_NOTICES.md'), await readFile(join(root, 'THIRD_PARTY_NOTICES.md')));
  for (const name of ['screenpipe-MIT.txt', 'memorylane-GPL-3.0.txt']) {
    assert.deepEqual(await readFile(join(resources, 'licenses', name)), await readFile(join(root, 'specs/001-event-driven-capture/licenses', name)), `Packaged license differs: ${name}`);
  }
  checks.push('ASAR production entries and runtime dependencies; smoke/navigationBenchmark and renderer fixtures excluded', 'third-party notices and both original license files match source bytes');
  return createHash('sha256').update(await readFile(archivePath)).digest('hex');
}

async function inspectHelper() {
  const binary = join(resources, 'native/one-room-helper');
  await access(binary, constants.X_OK);
  const helperSessionId = randomUUID();
  const command = (method, payload = {}) => ({
    protocolVersion: 1, helperSessionId, kind: 'command', method, requestId: randomUUID(),
    generation: 1, observationId: null, pid: null, windowId: null,
    issuedAt: Date.now(), deadlineAt: Date.now() + 5_000, payload,
  });
  const hello = command('hello', { role: 'executor' }), shutdown = command('shutdown');
  const child = spawn(binary, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  helperChildren.add(child);
  let stdout = '', stderrBytes = 0, sentShutdown = false;
  const completion = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > 128 * 1024) { child.kill('SIGKILL'); return; }
    if (!sentShutdown && stdout.includes('\n')) {
      sentShutdown = true;
      child.stdin.end(`${JSON.stringify(shutdown)}\n`);
    }
  });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 128 * 1024) child.kill('SIGKILL'); });
  child.stdin.write(`${JSON.stringify(hello)}\n`);
  try {
    const { code, signal } = await bounded(completion, 8_000, 'Packaged native helper handshake timed out.');
    assert.equal(code, 0, `Packaged helper exited with code ${code}, signal ${signal}.`);
    const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(responses.length, 2);
    for (const [index, request] of [hello, shutdown].entries()) {
      const response = responses[index];
      for (const name of ['protocolVersion', 'helperSessionId', 'method', 'requestId', 'generation', 'observationId', 'pid', 'windowId']) {
        assert.equal(response[name], request[name], `Helper response identity: ${name}`);
      }
      assert.equal(response.kind, 'result');
      assert.equal(response.status, 'ok');
      assert.ok(Number.isSafeInteger(response.startedAt) && response.finishedAt >= response.startedAt);
    }
    assert.equal(responses[0].payload.captureStarted, false);
    assert.equal(responses[0].payload.architecture, 'arm64');
    assert.equal(responses[0].payload.capabilities.windowCapture.supported, true);
    assert.equal(responses[0].payload.capabilities.visionOcr.supported, true);
    assert.equal(responses[1].payload.shutdown, true);
    checks.push('packaged native helper hello/shutdown; capture never started');
  } finally {
    await stopChild(child);
    helperChildren.delete(child);
  }
}

async function launch() {
  const env = { ...process.env, ONE_ROOM_USER_DATA: userData };
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--host-resolver-rules=MAP * ~NOTFOUND', '--proxy-server=http://127.0.0.1:9'],
    env, timeout: 30_000,
  });
  for (const stream of [application.process().stdout, application.process().stderr]) {
    stream?.on('data', chunk => { mainDiagnostics = (mainDiagnostics + chunk.toString('utf8')).slice(-32_768); });
  }
  await application.context().route(/^(?:https?|wss?):\/\//, route => { blockedRendererRequests++; return route.abort(); });
  const actual = await application.evaluate(({ app, session }) => {
    globalThis.__oneRoomPackageSmokeNetworkAttempts = 0;
    globalThis.fetch = async () => {
      globalThis.__oneRoomPackageSmokeNetworkAttempts++;
      throw new Error('Network is disabled for the packaged smoke test.');
    };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => {
      globalThis.__oneRoomPackageSmokeNetworkAttempts++;
      callback({ cancel: true });
    });
    return { isPackaged: app.isPackaged, userData: app.getPath('userData') };
  });
  assert.equal(actual.isPackaged, true);
  assert.equal(actual.userData, userData);
  const page = await application.firstWindow({ timeout: 20_000 });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => !!globalThis.oneRoom, undefined, { timeout: 15_000 });
  return page;
}

async function rpc(page, method, input = {}) {
  const [group, name] = method.split('.');
  const reply = await bounded(page.evaluate(({ group, name, input }) => globalThis.oneRoom[group][name](input), { group, name, input }), 15_000, `${method} timed out.`);
  assert.equal(JSON.stringify(reply).includes(apiKey), false, `${method} exposed the synthetic credential.`);
  assert.equal(reply.ok, true, `${method}: ${reply.error?.code ?? 'invalid response'} ${reply.error?.message ?? ''}`);
  assert.ok(Number.isSafeInteger(reply.dataRevision) && reply.dataRevision > 0);
  return reply.data;
}

async function assertPaused(page) {
  const status = await rpc(page, 'app.getStatus');
  assert.equal(status.schemaVersion, 6, 'The built app must contain schema 6; rebuild/package before rerunning.');
  assert.equal(status.storage.state, 'ready');
  assert.equal(status.storage.journalMode, 'wal');
  assert.equal(status.capture.state, 'paused');
  const settings = await rpc(page, 'settings.get');
  assert.equal(settings.captureEnabled, false);
  assert.equal(settings.textConsent.enabled, false);
  assert.deepEqual(settings.allowedBundleIds, []);
  assert.deepEqual(settings.textConsent.allowedBundleIds, []);
  return status;
}

function assertPublicConfig(config) {
  assert.deepEqual(Object.keys(config).sort(), ['revision', 'baseUrl', 'model', 'hasCredential', 'encryptionAvailable', 'lastTest'].sort());
  assert.equal(JSON.stringify(config).includes(apiKey), false);
}

async function assertNoNetwork() {
  assert.equal(blockedRendererRequests, 0, 'The packaged smoke unexpectedly attempted a renderer network request.');
  assert.equal(await application.evaluate(() => globalThis.__oneRoomPackageSmokeNetworkAttempts), 0, 'The packaged smoke unexpectedly attempted a main-process network request.');
}

async function run() {
  assert.equal(process.platform, 'darwin', 'This smoke checks the local macOS arm64 .app.');
  const sha256 = await inspectArchive();
  await inspectHelper();
  userData = await mkdtemp(join(tmpdir(), 'one-room-package-smoke-'));
  await chmod(userData, 0o700);
  let page = await launch();
  await assertPaused(page);
  checks.push('packaged production IPC, schema 6/WAL, capture paused and text consent off');

  const dateKey = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const rangeStart = Date.parse(`${dateKey}T00:00:00+08:00`), rangeEnd = rangeStart + 86_400_000;
  const absent = await rpc(page, 'report.get', { kind: 'daily', dateKey });
  assert.equal(absent.status, 'absent');
  const status = await rpc(page, 'app.getStatus');
  const reportRequest = { kind: 'daily', dateKey, expectedDataRevision: status.dataRevision, idempotencyKey: randomUUID() };
  const generated = await rpc(page, 'report.generate', reportRequest);
  assert.equal(generated.status, 'ready');
  assert.ok(generated.report?.id);
  assert.equal(generated.report.rangeStart, rangeStart);
  assert.equal(generated.report.rangeEnd, rangeEnd);
  assert.deepEqual(generated.report.periods, []);
  assert.equal((await rpc(page, 'report.get', { kind: 'daily', dateKey })).report?.id, generated.report.id);

  const config = await rpc(page, 'model.getConfig');
  assertPublicConfig(config);
  assert.equal(config.hasCredential, false);
  assert.equal(config.encryptionAvailable, true, 'Real Electron safeStorage must be available for this check.');
  const saved = await rpc(page, 'model.saveConfig', { expectedRevision: config.revision, baseUrl: 'https://one-room-package-smoke.invalid/v1', model: 'synthetic-never-call', apiKey });
  assertPublicConfig(saved);
  assert.equal(saved.hasCredential, true);
  assert.equal(saved.revision, config.revision + 1);
  const configPath = join(userData, 'model-settings.json');
  const storedText = await readFile(configPath, 'utf8'), stored = JSON.parse(storedText);
  assert.equal(storedText.includes(apiKey), false, 'Disk model configuration contains a plaintext credential.');
  assert.ok(typeof stored.encryptedApiKey === 'string' && stored.encryptedApiKey.length > 0);
  assert.ok(Buffer.from(stored.encryptedApiKey, 'base64').length > 0);
  assert.equal(stored.encryptedApiKey, Buffer.from(stored.encryptedApiKey, 'base64').toString('base64'));
  checks.push('model public responses omit key/ciphertext; disk JSON contains safeStorage ciphertext only');

  const preview = await rpc(page, 'history.previewDelete', { rangeStart, rangeEnd });
  assert.equal(preview.observationCount, 0);
  assert.equal(preview.periodCount, 0);
  assert.equal(preview.reportCount, 0);
  assert.ok(preview.expiresAt > Date.now());
  const deletionRequest = { deletionRef: preview.deletionRef, expectedRevision: preview.dataRevision, confirmed: true, idempotencyKey: randomUUID() };
  const deleted = await rpc(page, 'history.delete', deletionRequest);
  assert.equal(deleted.cleanup, 'complete');
  assert.ok(deleted.dataRevision > preview.dataRevision);
  assert.deepEqual(await rpc(page, 'history.delete', deletionRequest), deleted);
  await assertPaused(page);
  await assertNoNetwork();
  await closeApplication();

  page = await launch();
  await assertPaused(page);
  const persisted = await rpc(page, 'report.get', { kind: 'daily', dateKey });
  assert.equal(persisted.status, 'ready');
  assert.equal(persisted.report?.id, generated.report.id);
  assert.equal((await rpc(page, 'report.generate', reportRequest)).report?.id, generated.report.id);
  assert.deepEqual(await rpc(page, 'history.delete', deletionRequest), deleted);
  checks.push('report generate/get keeps ID and idempotency receipt across restart', 'empty-history preview/delete and durable idempotency replay');

  const reopened = await rpc(page, 'model.getConfig');
  assertPublicConfig(reopened);
  assert.equal(reopened.hasCredential, true);
  assert.equal(reopened.revision, saved.revision);
  const afterRestart = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(afterRestart.encryptedApiKey, stored.encryptedApiKey);
  assert.equal(await application.evaluate(({ safeStorage }, { ciphertext, expected }) => {
    return safeStorage.isEncryptionAvailable() && safeStorage.decryptString(Buffer.from(ciphertext, 'base64')) === expected;
  }, { ciphertext: afterRestart.encryptedApiKey, expected: apiKey }), true, 'Real Electron safeStorage could not decrypt the persisted synthetic key after restart.');
  const cleared = await rpc(page, 'model.clearCredential', { expectedRevision: reopened.revision });
  assertPublicConfig(cleared);
  assert.equal(cleared.hasCredential, false);
  const clearedText = await readFile(configPath, 'utf8');
  assert.equal(JSON.parse(clearedText).encryptedApiKey, null);
  assert.equal(clearedText.includes(apiKey), false);
  assert.equal(clearedText.includes(stored.encryptedApiKey), false);
  checks.push('real Electron safeStorage decrypts after restart; clear removes persisted ciphertext');
  await assertPaused(page);
  await assertNoNetwork();
  assert.deepEqual(pageErrors, []);
  checks.push('no page errors or network requests; isolated userData and no native capture');
  return { packageSmoke: 'passed', executablePath, asarPath: archivePath, asarSha256: sha256, schemaVersion: 6, checks };
}

try {
  const result = await run();
  await cleanup();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  try { await cleanup(); }
  catch (cleanupError) { console.error(`Cleanup failed: ${cleanupError.message}`); }
  console.error(JSON.stringify({ packageSmoke: 'failed', error: String(error.message).replaceAll(apiKey, '[synthetic-key]'), completedChecks: checks, mainDiagnostics: mainDiagnostics.replaceAll(apiKey, '[synthetic-key]') }, null, 2));
  process.exitCode = 1;
}
