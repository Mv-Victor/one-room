import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { deflateSync } from 'node:zlib';

const [workerFile, directory, dateKey] = process.argv.slice(2);
assert.ok(workerFile && directory && /^\d{4}-\d{2}-\d{2}$/.test(dateKey), 'Expected database worker, isolated userData and Shanghai date.');
const userData = resolve(directory);
assert.ok(basename(userData).startsWith('one-room-production-worklog-'), 'The seeder only accepts its isolated test directory.');

// A 320x200 checkerboard with PNG metadata explicitly identifying synthetic pixels.
// It contains no desktop screenshot and is shared by all three test observations.
const width = 320, height = 200, pixels = Buffer.alloc((width * 3 + 1) * height);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const color = (Math.floor(x / 20) + Math.floor(y / 20)) % 2 === 0 ? [230, 240, 245] : [25, 135, 120];
  pixels.set(color, y * (width * 3 + 1) + 1 + x * 3);
}
function chunk(name, data) {
  const type = Buffer.from(name), content = Buffer.concat([type, data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, content, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
  chunk('tEXt', Buffer.from('Description\0SYNTHETIC ONE ROOM E2E CHECKERBOARD; NOT A SCREEN CAPTURE')),
  chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
]);
const worker = new Worker(resolve(workerFile), { workerData: { databasePath: join(userData, 'one-room.sqlite') } });
const pending = new Map();
let failed;
const fail = error => {
  failed = error;
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); }
  pending.clear();
};
worker.on('error', fail);
worker.on('exit', () => fail(new Error('Synthetic seeding database worker stopped.')));
worker.on('message', reply => {
  const task = pending.get(reply.id);
  if (!task) return;
  pending.delete(reply.id); clearTimeout(task.timer);
  if (reply.ok) task.resolve(reply.result.data);
  else task.reject(new Error(`${reply.error.code}: ${reply.error.message}`));
});
function call(command, args = {}) {
  if (failed) return Promise.reject(failed);
  const id = randomUUID();
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Synthetic seed timed out: ${command}`)); }, 15_000);
    pending.set(id, { resolve: resolveResult, reject, timer });
    worker.postMessage({ id, command, args });
  });
}

try {
  await call('bootstrap');
  let settings = await call('settings.get');
  assert.equal(settings.captureEnabled, false);
  assert.equal(settings.textConsent.enabled, false);
  const apps = ['local.one-room.production-editor', 'local.one-room.production-kim'];
  settings = await call('settings.updateCaptureScope', { expectedRevision: settings.revision, allowedBundleIds: apps, excludedBundleIds: [] });
  // This worker only admits synthetic commits; no native process is started.
  const capture = await call('capture.setEnabled', { expectedRevision: settings.revision, enabled: true });
  const rangeStart = Date.parse(`${dateKey}T00:00:00+08:00`), at = rangeStart + 9 * 3_600_000;
  const sessionId = randomUUID(), sha256 = createHash('sha256').update(png).digest('hex');
  const imagePath = join(userData, 'evidence', `${sha256}.png`);
  await mkdir(join(userData, 'evidence'), { recursive: true, mode: 0o700 });
  await writeFile(imagePath, png, { mode: 0o600, flag: 'wx' });
  const token = `SyntheticWorklogPurgeToken${randomUUID().replaceAll('-', '')}`;
  const rows = [
    { offset: 0, appName: 'Synthetic Editor', bundleId: apps[0], windowId: 1, objectLabel: 'Synthetic Daily Document', topic: 'Capture Integration', action: 'suspected_edit', activityType: 'document' },
    { offset: 600_000, appName: 'Kim', bundleId: apps[1], windowId: 2, objectLabel: 'Synthetic Room Group', topic: 'Ten Second Interruption', action: 'view', activityType: 'group_chat' },
    { offset: 610_000, appName: 'Synthetic Editor', bundleId: apps[0], windowId: 1, objectLabel: 'Synthetic Daily Document', topic: 'Capture Integration', action: 'suspected_edit', activityType: 'document' },
  ];
  const observations = [];
  for (const row of rows) {
    const observation = { id: randomUUID(), sessionId, observedAt: at + row.offset,
      bundleId: row.bundleId, appName: row.appName, pid: 1, windowId: row.windowId,
      windowTitle: `SYNTHETIC - ${row.objectLabel}`, trigger: 'app_switch', captureGeneration: capture.generation,
      pairingStatus: 'matched', visibilityStatus: 'verified' };
    const evidenceId = randomUUID();
    await call('capture.commitObservation', { observation, evidenceId,
      blob: { id: randomUUID(), sha256, relativePath: `evidence/${sha256}.png`, mime: 'image/png', width: 320, height: 200, byteSize: png.length } });
    const activity = await call('text.commit', { observationId: observation.id, generation: capture.generation,
      records: [{ source: 'accessibility', status: 'ready', completeness: 'complete', text: `${token} ${row.objectLabel}; synthetic local text only.`, fallbackReason: null, observedAt: observation.observedAt }],
      selectedSource: 'accessibility', action: 'unknown' });
    await call('activity.review', { id: activity.activityId, expectedRevision: 1, action: row.action,
      activityType: row.activityType, objectLabel: row.objectLabel, topic: row.topic, confirmed: true });
    observations.push({ id: observation.id, evidenceId, at: observation.observedAt });
  }
  await call('capture.gap', { sessionId, generation: capture.generation, reason: 'paused', at: at + 1_510_000 });
  settings = await call('settings.get');
  await call('capture.pause', { expectedRevision: settings.revision });
  const snapshot = await call('worklog.read', { rangeStart, rangeEnd: rangeStart + 86_400_000 });
  assert.deepEqual(snapshot.periods.map(period => period.appName), ['Synthetic Editor', 'Kim', 'Synthetic Editor']);
  assert.equal(snapshot.periods[1].endTs - snapshot.periods[1].startTs, 10_000);
  const manifest = { synthetic: true, dateKey, rangeStart, rangeEnd: rangeStart + 86_400_000,
    token, observations, imagePath, recordedMs: 1_510_000, imageWidth: 320, imageHeight: 200 };
  await writeFile(join(userData, 'production-worklog-fixture.json'), JSON.stringify(manifest), { mode: 0o600 });
  console.log(JSON.stringify({ syntheticSeed: 'passed', observations: observations.length, captureStarted: false }));
} finally {
  try { if (!failed) await call('close'); }
  finally { await worker.terminate(); }
}
