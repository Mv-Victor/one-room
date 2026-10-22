import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { crc32, deflateSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { migrations } from '../../src/services/storage/migrations';
import { DatabaseClient } from '../../src/services/storage/client';
import type { StorageDiagnostics } from '../../src/services/storage/protocol';
import { createSnapshotQueries } from '../../src/services/worklog/queries';
import type { WorklogSnapshot } from '../../src/services/worklog/repository';
import type { Settings } from '../../src/shared/schemas';
import { DomainError } from '../../src/shared/errors';
import { dayBounds, monthBounds, DAY_MS } from '../../src/shared/time';

const DAYS = 30, OBSERVATIONS = 100_000, PERIODS = 10_000, BLOBS = 1_000;
const PERIODS_PER_DAY = Math.ceil(PERIODS / DAYS), STEP = 20_000;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV5kAAAAASUVORK5CYII=', 'base64');
const apps = ['local.one-room.benchmark-a', 'local.one-room.benchmark-b'];
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];
const rounded = (value: number) => Math.round(value * 100) / 100;
const timing = (values: number[]) => ({ count: values.length, p50Ms: rounded(percentile(values, 0.5)), p95Ms: rounded(percentile(values, 0.95)), maxMs: rounded(Math.max(...values)) });

function desktopImage(): Buffer {
  const width = 1280, height = 720, pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 3 + 1) + 1 + x * 3;
    const panel = Math.floor(x / 160) % 3, line = y % 24 < 3;
    pixels[at] = line ? 45 + panel * 30 : 215 + panel * 10;
    pixels[at + 1] = line ? 90 + panel * 20 : 235 - panel * 10;
    pixels[at + 2] = line ? 70 + panel * 30 : 245 - panel * 15;
  }
  const chunk = (type: string, bytes: Buffer) => {
    const output = Buffer.alloc(bytes.length + 12);
    output.writeUInt32BE(bytes.length); output.write(type, 4, 'ascii'); bytes.copy(output, 8);
    output.writeUInt32BE(crc32(output.subarray(4, -4)), output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([png.subarray(0, 8), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function image(index: number, base: Buffer = png): Buffer {
  const text = Buffer.from(`one-room-synthetic\0${index}`), chunk = Buffer.alloc(text.length + 12);
  chunk.writeUInt32BE(text.length); chunk.write('tEXt', 4, 'ascii'); text.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([base.subarray(0, -12), chunk, base.subarray(-12)]);
}
function observedAt(start: number, index: number): number {
  const period = Math.floor(index / 10), day = Math.floor(period / PERIODS_PER_DAY);
  return start + day * DAY_MS + (period % PERIODS_PER_DAY) * STEP * 10 + (index % 10) * STEP;
}

async function seed(path: string, root: string, start: number, desktop = false) {
  const directory = join(root, 'evidence'); await mkdir(directory);
  const blobs: { id: string; hash: string; size: number }[] = [];
  const base = desktop ? desktopImage() : png;
  for (let index = 0; index < BLOBS; index++) {
    const bytes = image(index, base), hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(directory, `${hash}.png`), bytes, { mode: 0o600 });
    blobs.push({ id: randomUUID(), hash, size: bytes.length });
  }
  const db = new Database(path);
  const ids: string[] = [];
  try {
    db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,appliedAt INTEGER NOT NULL)');
    for (const migration of migrations) {
      if (migration.foreignKeysOff) db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration.version, createHash('sha256').update(migration.sql).digest('hex'), Date.now());
      })();
      db.pragma('foreign_keys = ON');
    }
    const session = randomUUID();
    db.transaction(() => {
      const blobInsert = db.prepare("INSERT INTO evidence_blobs(id,sha256,relativePath,mime,width,height,byteSize,createdAt) VALUES(?,?,?,'image/png',?,?,?,?)");
      for (const blob of blobs) blobInsert.run(blob.id, blob.hash, `evidence/${blob.hash}.png`, desktop ? 1280 : 1, desktop ? 720 : 1, blob.size, start);
      const captureInsert = db.prepare(`INSERT INTO capture_events(id,commitSequence,sessionId,observedAt,endTs,bundleId,appName,pid,windowId,windowTitle,trigger,captureGeneration,pairingStatus,visibilityStatus,textStatus)
        VALUES(?,?,?,?,?,?,?,1,?,?,'checkpoint',1,'matched','verified','ready')`);
      const evidenceInsert = db.prepare('INSERT INTO evidence(id,captureEventId,blobId,observedAt,expiresAt) VALUES(?,?,?,?,?)');
      const activityInsert = db.prepare("INSERT INTO activity_events(id,captureEventId,action,activityType,objectLabel,topic,basis,analysisStatus) VALUES(?,?,'view','document',?,'Synthetic benchmark','observed','not_authorized')");
      const observationSource = db.prepare("INSERT INTO source_refs(id,kind,captureEventId) VALUES(?,'observation',?)");
      const imageSource = db.prepare("INSERT INTO source_refs(id,kind,evidenceId) VALUES(?,'image',?)");
      const activitySource = db.prepare("INSERT INTO source_refs(id,kind,activityEventId) VALUES(?,'activity',?)");
      const textInsert = db.prepare("INSERT INTO text_evidence(id,captureEventId,source,status,completeness,text,observedAt,selected) VALUES(?,?,'accessibility','ready','complete',?,?,1)");
      const textSource = db.prepare("INSERT INTO source_refs(id,kind,textEvidenceId) VALUES(?,'text',?)");
      const searchInsert = db.prepare('INSERT INTO text_search(textEvidenceId,text) VALUES(?,?)');
      const titleInsert = db.prepare('INSERT INTO capture_search(captureEventId,title) VALUES(?,?)');
      for (let index = 0; index < OBSERVATIONS; index++) {
        const id = randomUUID(), evidenceId = randomUUID(), activityId = randomUUID(), period = Math.floor(index / 10);
        const at = observedAt(start, index), app = period % 2, title = `Synthetic window ${period}`;
        ids.push(id);
        captureInsert.run(id, index + 1, session, at, at + STEP, apps[app], `Benchmark ${app}`, app + 1, title);
        evidenceInsert.run(evidenceId, id, blobs[index % BLOBS].id, at, at + 30 * DAY_MS);
        activityInsert.run(activityId, id, `Synthetic task ${period}`);
        observationSource.run(randomUUID(), id); imageSource.run(randomUUID(), evidenceId); activitySource.run(randomUUID(), activityId);
        titleInsert.run(id, title);
        if (index % 100 === 0) {
          const textId = randomUUID(), body = `benchmarkneedle 日报 synthetic body ${index}`;
          textInsert.run(textId, id, body, at); textSource.run(randomUUID(), textId); searchInsert.run(textId, body);
        }
      }
    })();
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal((db.prepare('SELECT count(DISTINCT blobId) AS n FROM evidence WHERE expiresAt>?').get(Date.now()) as { n: number }).n, BLOBS);
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  return ids;
}

export async function runNavigationBenchmark(workerPath: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'one-room-navigation-benchmark-')), path = join(root, 'benchmark.sqlite');
  let database: DatabaseClient | null = null;
  try {
    // A future synthetic month keeps every image reference inside its 30-day TTL.
    const anchor = new Date(); anchor.setUTCDate(1); anchor.setUTCMonth(anchor.getUTCMonth() + 1);
    while (monthBounds(anchor.toISOString().slice(0, 7)).rangeEnd - monthBounds(anchor.toISOString().slice(0, 7)).rangeStart < DAYS * DAY_MS) anchor.setUTCMonth(anchor.getUTCMonth() + 1);
    const month = anchor.toISOString().slice(0, 7), rangeStart = monthBounds(month).rangeStart;
    const range = { rangeStart, rangeEnd: rangeStart + DAYS * DAY_MS }, started = performance.now();
    const ids = await seed(path, root, range.rangeStart), seedMs = performance.now() - started;
    database = new DatabaseClient(workerPath, path);
    const call = async <T>(command: string, args: unknown = {}) => (await database!.call<T>(command, args)).data;
    const queries = createSnapshotQueries({ read: input => call<WorklogSnapshot>('worklog.read', input) });
    const warmupStart = performance.now(), initial = await call<WorklogSnapshot>('worklog.read', range), warmupMs = performance.now() - warmupStart;
    assert.equal(initial.periods.length, PERIODS); assert.equal(initial.observations.length, OBSERVATIONS);
    assert.equal(new Set(initial.periods.map(period => Math.floor((period.startTs - rangeStart) / DAY_MS))).size, DAYS);
    const diagnostics = await call<StorageDiagnostics>('bootstrap');
    const cursorTimes: number[] = [], rangeTimes: number[] = [], dayTimes: number[] = [], monthTimes: number[] = [];
    const searches: { query: string; durationMs: number }[] = [];
    for (let index = 0; index < 100; index++) {
      const observationIndex = ((index * 97) % PERIODS) * 10 + 5, cursorTs = observedAt(range.rangeStart, observationIndex) + STEP / 2;
      const begin = performance.now(), result = await queries.cursor({ cursorTs, queryRevision: initial.dataRevision });
      cursorTimes.push(performance.now() - begin);
      assert.equal(result.observation?.id, ids[observationIndex]); assert.equal(result.evidence?.status, 'available');
      assert.equal(result.period?.id, ids[observationIndex - 5]);
    }
    for (let index = 0; index < 20; index++) {
      const begin = performance.now();
      if (index % 2 === 0) {
        const date = new Date(range.rangeStart + Math.floor(index / 2) * DAY_MS + 8 * 3_600_000).toISOString().slice(0, 10);
        const result = await queries.timeline({ ...dayBounds(date), limit: 500 });
        assert.equal(result.periods.length, PERIODS_PER_DAY);
      } else {
        const result = await queries.calendar({ month, limit: 500 });
        assert.equal(result.days.flatMap(day => day.periods).length, 500);
      }
      const duration = performance.now() - begin;
      rangeTimes.push(duration); (index % 2 === 0 ? dayTimes : monthTimes).push(duration);
    }
    for (const query of ['benchmarkneedle', '日报']) {
      const begin = performance.now(), result = await queries.timeline({ ...range, query, limit: 500 });
      searches.push({ query, durationMs: rounded(performance.now() - begin) });
      assert.equal(result.periods.length, 500); assert.equal(result.filteredDurationMs, 1_000 * STEP * 10);
    }
    const first = await queries.timeline({ ...range, limit: 1 }); assert.ok(first.nextCursor);
    const settings = await call<Settings>('settings.get');
    await call('settings.updateCaptureScope', { expectedRevision: settings.revision, allowedBundleIds: apps, excludedBundleIds: [] });
    await assert.rejects(queries.timeline({ ...range, limit: 1, cursor: first.nextCursor! }), (error: unknown) => error instanceof DomainError && error.error.code === 'STALE_REVISION');
    const cursor = timing(cursorTimes), navigation = timing(rangeTimes);
    const cursorP95 = percentile(cursorTimes, 0.95), navigationP95 = percentile(rangeTimes, 0.95);
    const result = {
      measuredAt: new Date().toISOString(),
      status: cursorP95 <= 1_000 && navigationP95 <= 2_000 ? 'passed' : 'failed',
      scope: 'Synthetic SQLite worker/service round trips only; excludes browser image decoding and physical three-finger gestures.',
      machine: { platform: platform(), osRelease: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(),
        electron: process.versions.electron, node: process.versions.node, sqlite: diagnostics.sqliteVersion, schemaVersion: diagnostics.schemaVersion },
      cache: { initialRead: 'New SQLite worker after seeding; OS filesystem cache is warm and is not flushed.',
        measuredRequests: 'Sequential requests after one full-range read; SQLite and OS caches may be warm. No overlapping capture or image decoding.' },
      fixture: { month, days: DAYS, rangeStart: range.rangeStart, rangeEnd: range.rangeEnd, observations: OBSERVATIONS, semanticPeriods: PERIODS,
        validImageBlobs: BLOBS, evidenceReferences: OBSERVATIONS, selectedTextRows: 1_000, databaseBytes: (await stat(path)).size },
      seedMs: rounded(seedMs), warmupMs: rounded(warmupMs), cursor, dayAndMonth: navigation, day: timing(dayTimes), month: timing(monthTimes), searches,
      thresholds: { cursorP95Ms: 1_000, dayAndMonthP95Ms: 2_000 }, stalePaginationRejected: true,
    };
    await mkdir(resolve('artifacts/acceptance'), { recursive: true });
    await writeFile(resolve('artifacts/acceptance/navigation-benchmark.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
    assert.ok(cursorP95 <= 1_000, 'Cursor service p95 must be at most 1 second.');
    assert.ok(navigationP95 <= 2_000, 'Day/month service p95 must be at most 2 seconds.');
  } finally {
    if (database) await database.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--seed-renderer') {
  const root = resolve(process.argv[3]), rangeEnd = dayBounds(new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)).rangeStart;
  const rangeStart = rangeEnd - DAYS * DAY_MS;
  await seed(join(root, 'one-room.sqlite'), root, rangeStart, true);
  await writeFile(join(root, 'benchmark-metadata.json'), JSON.stringify({ rangeStart, rangeEnd, observations: OBSERVATIONS, periods: PERIODS, blobs: BLOBS,
    periodsPerDay: PERIODS_PER_DAY, stepMs: STEP, width: 1280, height: 720 }));
} else await runNavigationBenchmark(resolve(dirname(fileURLToPath(import.meta.url)), 'database.js'));
