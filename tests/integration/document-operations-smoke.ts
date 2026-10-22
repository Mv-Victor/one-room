import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { LocalMarkdownConnector } from '../../src/services/documents/local-markdown';
import { LocalDocumentOperations, type ApplyMarkdownInput, type DocumentOperationHost, type LocalDocumentOperation } from '../../src/services/documents/operations';

export async function runDocumentOperationsSmoke(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'one-room-document-operations-')), databasePath = join(root, 'operations.sqlite');
  let database = new Database(databasePath), offline = false;
  const initialize = () => {
    database.pragma('journal_mode = WAL'); database.pragma('synchronous = FULL');
    database.exec('CREATE TABLE IF NOT EXISTS document_fixture_operations(id TEXT PRIMARY KEY,targetId TEXT NOT NULL,idempotencyKey TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(targetId,idempotencyKey))');
  };
  initialize();
  const parse = (row: unknown) => row ? JSON.parse((row as { json: string }).json) as LocalDocumentOperation : null;
  const host: DocumentOperationHost = {
    get: async id => parse(database.prepare('SELECT json FROM document_fixture_operations WHERE id=?').get(id)),
    findByIdempotencyKey: async (targetId, key) => parse(database.prepare('SELECT json FROM document_fixture_operations WHERE targetId=? AND idempotencyKey=?').get(targetId, key)),
    createIntent: async operation => database.transaction(() => {
      database.prepare('INSERT OR IGNORE INTO document_fixture_operations VALUES(?,?,?,?)').run(operation.id, operation.targetId, operation.idempotencyKey, JSON.stringify(operation));
      return parse(database.prepare('SELECT json FROM document_fixture_operations WHERE targetId=? AND idempotencyKey=?').get(operation.targetId, operation.idempotencyKey))!;
    })(),
    update: async operation => {
      if (offline) throw new Error('Synthetic persistence outage');
      database.prepare('UPDATE document_fixture_operations SET json=? WHERE id=?').run(JSON.stringify(operation), operation.id);
      return operation;
    },
  };
  const connector = new LocalMarkdownConnector(), guard = async () => true;
  const prepare = async (name: string): Promise<ApplyMarkdownInput> => {
    const path = join(root, name); await writeFile(path, '\ufeff# Notes\r\n\r\n## 2026-10-16\r\n\r\n- Old\r\n\r\n## Keep\r\n\r\nOutside bytes\r\n');
    const target = await connector.register(path), snapshot = await connector.inspect(target), section = connector.confirm(snapshot, snapshot.sections[1].sectionRef);
    const candidate = connector.candidate(snapshot, section, '## 2026-10-16\n\n- Completed synthetic work\n\n');
    return { target, snapshot, section, candidate, idempotencyKey: randomUUID(), runId: randomUUID(), generation: 1,
      approvalRef: randomUUID(), approvalBindingHash: 'c'.repeat(64), exclusive: true };
  };
  try {
    // SQLite intent survives reopening even when persistence disappears immediately after rename.
    const request = await prepare('daily.md'), persist = host.update;
    host.update = async operation => { if (operation.stage === 'renamed') offline = true; return persist(operation); };
    await assert.rejects(new LocalDocumentOperations(connector, host).apply(request, guard));
    const intent = parse(database.prepare('SELECT json FROM document_fixture_operations WHERE targetId=?').get(request.target.id))!;
    assert.equal(intent.state, 'applying'); assert.equal(intent.stage, 'temporary_synced');
    assert.deepEqual(await readFile(request.target.canonicalPath), request.candidate.afterBytes);
    const afterWrite = await stat(request.target.canonicalPath);
    database.close(); database = new Database(databasePath); initialize(); offline = false; host.update = persist;
    const operations = new LocalDocumentOperations(connector, host), recovered = await operations.recover(intent.id, guard);
    assert.equal(recovered.state, 'succeeded'); assert.equal(recovered.stage, 'verified'); assert.equal(recovered.applied, true);
    assert.equal((await stat(request.target.canonicalPath)).ino, afterWrite.ino);
    assert.equal((await stat(request.target.canonicalPath)).mtimeMs, afterWrite.mtimeMs);
    assert.deepEqual(await operations.apply(request, guard), recovered);

    // A durable intent with untouched before bytes is interrupted; differing bytes are conflict.
    for (const mode of ['before', 'other'] as const) {
      const pending = await prepare(`${mode}.md`);
      host.update = async operation => { if (operation.stage === 'temporary_synced') offline = true; return persist(operation); };
      await assert.rejects(operations.apply(pending, guard));
      const saved = parse(database.prepare('SELECT json FROM document_fixture_operations WHERE targetId=?').get(pending.target.id))!;
      offline = false; host.update = persist;
      if (mode === 'other') await writeFile(pending.target.canonicalPath, '# Outside edit\n');
      const result = await new LocalDocumentOperations(connector, host).recover(saved.id, guard);
      assert.equal(result.state, mode === 'before' ? 'interrupted' : 'conflict'); assert.equal(result.applied, mode === 'before' ? false : null);
      assert.deepEqual(await readFile(pending.target.canonicalPath), mode === 'before' ? pending.snapshot.bytes : Buffer.from('# Outside edit\n'));
    }
    console.log('Document operation smoke: SQLite restart, BOM/CRLF/outside bytes, post-rename no-replay, before/other recovery passed.');
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
}
