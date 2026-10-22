import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '../../src/shared/errors';
import { LocalMarkdownConnector, MAX_MARKDOWN_BYTES } from '../../src/services/documents/local-markdown';
import { LocalDocumentOperations, type ApplyMarkdownInput, type DocumentOperationHost, type LocalDocumentOperation } from '../../src/services/documents/operations';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const connector = new LocalMarkdownConnector();
const always = async () => true;
const rejected = (detailCode: string) => expect.objectContaining({ error: expect.objectContaining({ detailCode }) });
async function fixture(bytes: string | Buffer, name = 'daily.md') {
  const root = await mkdtemp(join(tmpdir(), 'one-room-markdown-')); roots.push(root);
  const path = join(root, name); await writeFile(path, bytes);
  const target = await connector.register(path), snapshot = await connector.inspect(target);
  return { root, path, target, snapshot };
}
function host(): DocumentOperationHost & { records: Map<string, LocalDocumentOperation> } {
  const records = new Map<string, LocalDocumentOperation>();
  const clone = (value: LocalDocumentOperation) => JSON.parse(JSON.stringify(value)) as LocalDocumentOperation;
  return { records,
    findByIdempotencyKey: async (targetId, key) => [...records.values()].find(item => item.targetId === targetId && item.idempotencyKey === key) ?? null,
    get: async id => records.get(id) ?? null,
    createIntent: async operation => { records.set(operation.id, clone(operation)); return clone(operation); },
    update: async operation => { records.set(operation.id, clone(operation)); return clone(operation); },
  };
}
function input(snapshot: Awaited<ReturnType<typeof connector.inspect>>, index: number, replacement: string): ApplyMarkdownInput {
  const section = connector.confirm(snapshot, snapshot.sections[index].sectionRef), candidate = connector.candidate(snapshot, section, replacement);
  return { idempotencyKey: randomUUID(), runId: randomUUID(), generation: 1, approvalRef: randomUUID(), approvalBindingHash: 'a'.repeat(64),
    target: snapshot.target, snapshot, section, candidate, exclusive: true };
}

describe('local Markdown target and section handling', () => {
  it('preserves BOM, CRLF and all bytes outside one Chinese date section', async () => {
    const before = Buffer.from('\ufeff# 工作日志\r\n\r\n## 2026-10-15\r\n\r\n- 原文\r\n\r\n## 2026-10-16\r\n\r\n- 下一个日期\r\n');
    const { snapshot } = await fixture(before);
    const section = connector.confirm(snapshot, snapshot.sections[1].sectionRef);
    const candidate = connector.candidate(snapshot, section, '## 2026-10-15\n\n- 已完成\n\n');
    expect(snapshot.bom).toBe(true); expect(snapshot.newline).toBe('\r\n');
    expect(candidate.afterBytes.subarray(0, section.startByte)).toEqual(before.subarray(0, section.startByte));
    expect(candidate.afterBytes.subarray(section.startByte + candidate.replacementBytes.length)).toEqual(before.subarray(section.endByte));
    expect(candidate.afterBytes.toString()).toContain('已完成\r\n');
    expect(candidate.diff).toContain('-- 原文'); expect(candidate.diff).toContain('+- 已完成');
    expect(candidate.diff).not.toContain(snapshot.target.canonicalPath);
  });

  it.each([
    '# Weekly log\n\n## 2026-10-12 to 2026-10-18\n\nOld\n',
    '# Ordinary document\n\n## Status\n\nOld\n',
  ])('supports an ordinary section without changing its heading', async text => {
    const { snapshot } = await fixture(text, 'notes.markdown');
    const section = connector.confirm(snapshot, snapshot.sections[1].sectionRef);
    const candidate = connector.candidate(snapshot, section, `${section.heading}\n\nUpdated\n`);
    expect(candidate.afterBytes.toString()).toContain('Updated');
    expect(() => connector.candidate(snapshot, section, '## Another section\n\nChanged\n')).toThrow(DomainError);
    expect(() => connector.candidate(snapshot, section, `${section.heading}\n\n## 2026-10-19\nNew date\n`)).toThrow(DomainError);
  });

  it('rejects invalid encoding, duplicate headings/dates, mixed line endings and oversized files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'one-room-invalid-markdown-')); roots.push(root);
    const path = join(root, 'bad.md');
    for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from('# A\n\n## B\n\n## B\n'), Buffer.from('# 2026-10-15 A\n\n## 2026-10-15 B\n'),
      Buffer.from('# A\r\n\nMixed\n'), Buffer.from('# A\n\0text'), Buffer.alloc(MAX_MARKDOWN_BYTES + 1, 97)]) {
      await writeFile(path, bytes);
      await expect(connector.register(path)).rejects.toBeInstanceOf(DomainError);
    }
  });

  it('checks the original leaf before realpath and detects ancestor or file replacement', async () => {
    const { root, path, target } = await fixture('# A\n\nOld\n');
    const linked = join(root, 'link.md'); await symlink(path, linked);
    await expect(connector.register(linked)).rejects.toEqual(rejected('UNSUPPORTED_FORMAT'));
    const replacement = join(root, 'new.md'); await writeFile(replacement, '# A\n\nReplacement\n'); await rename(replacement, path);
    await expect(connector.inspect(target)).rejects.toEqual(rejected('TARGET_CONFLICT'));
    const parent = join(root, 'folder'); await mkdir(parent); const nested = join(parent, 'nested.md'); await writeFile(nested, '# Nested\n');
    const nestedTarget = await connector.register(nested); await rename(parent, join(root, 'moved')); await mkdir(parent); await writeFile(nested, '# Nested\n');
    await expect(connector.inspect(nestedTarget)).rejects.toEqual(rejected('TARGET_CONFLICT'));
  });
});

describe('durable local document operations', () => {
  it('writes only after intent, preserves permissions, and returns the same result for a retry', async () => {
    const { path, snapshot } = await fixture('# Notes\n\n## Status\n\nOld\n\n## Keep\n\nOutside\n');
    const store = host(), operations = new LocalDocumentOperations(connector, store), request = input(snapshot, 1, '## Status\n\nNew\n\n');
    const mode = (await stat(path)).mode & 0o777;
    const result = await operations.apply(request, async (operation, phase) => {
      if (phase === 'before_rename') expect(store.records.has(operation.id)).toBe(true);
      return true;
    });
    expect(result.state).toBe('succeeded'); expect(result.applied).toBe(true);
    expect(await readFile(path)).toEqual(request.candidate.afterBytes); expect((await stat(path)).mode & 0o777).toBe(mode);
    expect(await operations.apply(request, always)).toEqual(result); expect(store.records.size).toBe(1);
    await expect(operations.apply({ ...request, approvalRef: randomUUID() }, always)).rejects.toEqual(rejected('IDEMPOTENCY_CONFLICT'));
  });

  it('does not rewrite identical bytes, and nonexclusive editing only permits patch review', async () => {
    const { path, snapshot } = await fixture('# Notes\n\n## Status\n\nOld\n');
    const request = input(snapshot, 1, '## Status\n\nOld\n'), store = host(), operations = new LocalDocumentOperations(connector, store);
    const before = await stat(path);
    await expect(operations.apply({ ...request, exclusive: false }, always)).rejects.toEqual(rejected('EXCLUSIVE_EDIT_REQUIRED'));
    expect(store.records.size).toBe(0); expect((await operations.apply(request, always)).state).toBe('no_change');
    expect((await stat(path)).ino).toBe(before.ino); expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    const invalidated = host(), create = invalidated.createIntent;
    invalidated.createIntent = operation => create({ ...operation, state: 'source_invalidated', detailCode: 'SOURCE_DELETED' });
    const result = await new LocalDocumentOperations(connector, invalidated).apply({ ...request, idempotencyKey: randomUUID() }, always);
    expect(result.state).toBe('source_invalidated'); expect(result.applied).toBe(false);
    expect((await stat(path)).ino).toBe(before.ino); expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it('serializes one target and refuses a competing update based on the old identity', async () => {
    const { path, snapshot } = await fixture('# Notes\n\n## Status\n\nOld\n');
    const store = host(), operations = new LocalDocumentOperations(connector, store);
    const first = input(snapshot, 1, '## Status\n\nFirst\n'), second = input(snapshot, 1, '## Status\n\nSecond\n');
    const results = await Promise.allSettled([operations.apply(first, always), operations.apply(second, always)]);
    expect(results[0].status).toBe('fulfilled'); expect(results[1].status).toBe('rejected');
    expect(await readFile(path, 'utf8')).toContain('First'); expect(store.records.size).toBe(1);
  });

  it('leaves an unrelated preexisting temporary filename intact', async () => {
    const { root, path, snapshot } = await fixture('# Notes\n\n## Status\n\nOld\n');
    const request = { ...input(snapshot, 1, '## Status\n\nNew\n'), operationId: randomUUID() };
    const temporary = join(root, `.one-room-${request.operationId}.tmp`); await writeFile(temporary, 'Unrelated file');
    await expect(new LocalDocumentOperations(connector, host()).apply(request, always)).rejects.toEqual(rejected('WRITE_FAILED'));
    expect(await readFile(temporary, 'utf8')).toBe('Unrelated file'); expect(await readFile(path)).toEqual(snapshot.bytes);
  });

  it('checks sources immediately before rename and records actual application if deletion follows the write', async () => {
    const { path, snapshot } = await fixture('# Notes\n\n## Status\n\nOld\n');
    const store = host(), operations = new LocalDocumentOperations(connector, store), request = input(snapshot, 1, '## Status\n\nNew\n');
    await expect(operations.apply(request, async (_operation, phase) => phase !== 'before_rename')).rejects.toEqual(rejected('SOURCE_DELETED'));
    expect(await readFile(path)).toEqual(snapshot.bytes);
    const next = { ...request, idempotencyKey: randomUUID() };
    const result = await operations.apply(next, async (_operation, phase) => phase !== 'after_write');
    expect(result.state).toBe('source_invalidated'); expect(result.applied).toBe(true); expect(await readFile(path)).toEqual(request.candidate.afterBytes);
  });

  it.each(['after', 'other'] as const)('recovers a post-rename crash with %s bytes without replaying the write', async mode => {
    const { path, snapshot } = await fixture('# Notes\n\n## Status\n\nOld\n');
    const store = host(), persist = store.update; let crash = false;
    store.update = async operation => { if (operation.stage === 'renamed' || crash) { crash = true; throw new Error('Synthetic database outage'); } return persist(operation); };
    const operations = new LocalDocumentOperations(connector, store), request = input(snapshot, 1, '## Status\n\nNew\n');
    await expect(operations.apply(request, always)).rejects.toThrow();
    const saved = [...store.records.values()][0];
    expect(saved.state).toBe('applying'); expect(saved.stage).toBe('temporary_synced'); expect(await readFile(path)).toEqual(request.candidate.afterBytes);
    if (mode === 'other') await writeFile(path, '# Outside edit\n');
    const written = await stat(path);
    store.update = persist;
    const result = await new LocalDocumentOperations(connector, store).recover(saved.id, always);
    expect(result.state).toBe(mode === 'after' ? 'succeeded' : 'conflict'); expect(result.applied).toBe(mode === 'after' ? true : null);
    expect((await stat(path)).ino).toBe(written.ino); expect((await stat(path)).mtimeMs).toBe(written.mtimeMs);
    expect(await operations.recover(saved.id, always)).toEqual(result);
  });
});
