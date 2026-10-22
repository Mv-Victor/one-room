import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { DocumentSkill, DocumentSkillDraft, DocumentSkillVersion, RunView } from '../../shared/execution-schemas';
import type { Settings } from '../../shared/schemas';
import { StorageError } from './client';
import type { LocalDocumentOperation } from '../documents/operations';

export type ExecutionSource = { sourceRefId: string; revision: number; observedAt: number; label: string; text: string };
export type ExecutionRunRecord = {
  view: RunView; frozenInput: string | null; sourceGeneration: number; sourceRevisions: { sourceRefId: string; revision: number }[];
  snapshot: unknown | null; proposalBytes: string | null; candidate: unknown | null;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missing = (detail: string): never => { throw new StorageError('NOT_FOUND', 'The requested document resource is unavailable.', detail); };

export function scrubExecutionSources(db: Database.Database, sourceRefIds: readonly string[], at: number): void {
  if (!sourceRefIds.length) return;
  const ids = JSON.stringify(sourceRefIds);
  const rows = db.prepare(`SELECT r.id,r.body,r.status FROM runs r JOIN run_sources s ON s.runId=r.id
    WHERE s.sourceRefId IN (SELECT value FROM json_each(?)) GROUP BY r.id`).all(ids) as { id: string; body: string | null; status: string }[];
  for (const row of rows) {
    if (!row.body) continue;
    const run = JSON.parse(row.body) as ExecutionRunRecord;
    run.frozenInput = null; run.snapshot = null; run.candidate = null; run.proposalBytes = null;
    run.view = { ...run.view, state: 'source_invalidated', generation: run.view.generation + 1, inputPreview: null, proposal: null,
      diff: null, approvalRef: null, error: { code: 'SOURCE_INVALIDATED', detailCode: 'SOURCE_DELETED', message: '所选记录已删除。' }, updatedAt: at };
    db.prepare('UPDATE runs SET status=?,generation=?,body=?,updatedAt=? WHERE id=?').run(run.view.state, run.view.generation, JSON.stringify(run), at, row.id);
    db.prepare('UPDATE document_operations SET body=NULL WHERE runId=?').run(row.id);
    // Cached command replies may contain the reviewed source text or proposal.
    db.prepare("DELETE FROM execution_receipts WHERE json_extract(result,'$.runId')=? OR json_extract(result,'$.view.runId')=?").run(row.id, row.id);
  }
  const skills = db.prepare('SELECT id,body FROM skills').all() as { id: string; body: string }[];
  const removed = new Set(sourceRefIds);
  for (const row of skills) {
    const saved = JSON.parse(row.body) as DocumentSkill & { sourceRefs?: string[] };
    if (!saved.sourceRefs?.some(id => removed.has(id))) continue;
    saved.status = 'source_deleted'; saved.draftRevision++;
    // User-authored format rules can be retained, but derived task instructions cannot.
    saved.draft = { ...saved.draft, title: '来源已删除', instructions: '请重新选择来源并确认规则。',
      formatRules: '请重新确认格式规则。', deduplication: '请重新确认去重规则。' };
    db.prepare('UPDATE skills SET status=?,draftRevision=?,body=? WHERE id=?').run(saved.status, saved.draftRevision, JSON.stringify(saved), row.id);
    db.prepare("UPDATE skill_versions SET body=json_set(body,'$.invalidated',1,'$.draft.title','来源已删除','$.draft.instructions','请重新选择来源并确认规则。','$.draft.formatRules','请重新确认格式规则。','$.draft.deduplication','请重新确认去重规则。') WHERE skillId=?").run(row.id);
    db.prepare("DELETE FROM execution_receipts WHERE json_extract(result,'$.id')=? OR json_extract(result,'$.skillId')=?").run(row.id, row.id);
  }
}

export function createExecutionCommands(db: Database.Database, host: { settings(): Settings; revision(): number; bump(): void }): Record<string, (args: never) => unknown> {
  const generation = () => (db.prepare('SELECT sourceGeneration FROM settings WHERE id=1').get() as { sourceGeneration: number }).sourceGeneration;
  const sourceRows = (ids?: readonly string[], limit = 100): ExecutionSource[] => {
    const policy = host.settings();
    return (db.prepare(`SELECT s.id AS sourceRefId,s.currentRevision AS revision,c.observedAt,c.appName,c.windowTitle,c.bundleId,t.text
      FROM source_refs s JOIN text_evidence t ON t.id=s.textEvidenceId JOIN capture_events c ON c.id=t.captureEventId
      WHERE s.kind='text' AND s.state='valid' AND c.deletedAt IS NULL AND t.selected=1 AND length(trim(t.text))>0
      ${ids ? 'AND s.id IN (SELECT value FROM json_each(@ids))' : ''}
      AND c.bundleId IN (SELECT value FROM json_each(@allowed)) AND c.bundleId NOT IN (SELECT value FROM json_each(@excluded))
      ORDER BY c.observedAt DESC,s.id LIMIT @limit`).all({ ...(ids ? { ids: JSON.stringify(ids) } : {}), allowed: JSON.stringify(policy.allowedBundleIds), excluded: JSON.stringify(policy.excludedBundleIds), limit }) as {
        sourceRefId: string; revision: number; observedAt: number; appName: string; windowTitle: string | null; text: string;
      }[]).map(row => ({ sourceRefId: row.sourceRefId, revision: row.revision, observedAt: row.observedAt,
        label: `${row.appName}${row.windowTitle ? ` · ${row.windowTitle}` : ''}`.slice(0, 1024), text: row.text }));
  };
  const sourcesValid = (run: ExecutionRunRecord) => {
    if (run.sourceGeneration !== generation()) return false;
    const current = sourceRows(run.sourceRevisions.map(source => source.sourceRefId), 2000);
    return current.length === run.sourceRevisions.length && current.every(source => run.sourceRevisions.some(saved => saved.sourceRefId === source.sourceRefId && saved.revision === source.revision));
  };
  const receipt = (scope: string, key: string, payload: unknown) => {
    const row = db.prepare('SELECT payloadHash,result FROM execution_receipts WHERE scope=? AND idempotencyKey=?').get(scope, key) as { payloadHash: string; result: string } | undefined;
    if (!row) return undefined;
    if (row.payloadHash !== digest(payload)) throw new StorageError('CONFLICT', 'The request key was already used for another action.', 'IDEMPOTENCY_CONFLICT');
    return JSON.parse(row.result) as unknown;
  };
  const putReceipt = (scope: string, key: string, payload: unknown, result: unknown) => {
    db.prepare('INSERT INTO execution_receipts VALUES(?,?,?,?)').run(scope, key, digest(payload), JSON.stringify(result));
  };
  const loadRun = (id: string): ExecutionRunRecord => {
    const row = db.prepare('SELECT body FROM runs WHERE id=?').get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as ExecutionRunRecord : missing('RUN_NOT_FOUND');
  };
  return {
    'execution.targets': () => (db.prepare('SELECT body FROM document_targets ORDER BY rowid DESC LIMIT 1000').all() as { body: string }[]).map(row => JSON.parse(row.body)),
    'execution.target': ({ id }: { id: string }) => {
      const row = db.prepare('SELECT body FROM document_targets WHERE id=?').get(id) as { body: string } | undefined;
      return row ? JSON.parse(row.body) : missing('TARGET_NOT_FOUND');
    },
    'execution.saveTarget': ({ id, revision, body, expectedRevision }: { id: string; revision: number; body: unknown; expectedRevision?: number }) => db.transaction(() => {
      const previous = db.prepare('SELECT revision FROM document_targets WHERE id=?').get(id) as { revision: number } | undefined;
      if (previous && previous.revision !== expectedRevision) throw new StorageError('STALE_REVISION', 'The document selection changed.');
      db.prepare('INSERT INTO document_targets VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(id, revision, JSON.stringify(body));
      host.bump(); return body;
    })(),
    'execution.skills': () => (db.prepare('SELECT body FROM skills ORDER BY rowid DESC LIMIT 1000').all() as { body: string }[]).map(row => JSON.parse(row.body)),
    'execution.skill': ({ id }: { id: string }) => {
      const row = db.prepare('SELECT body FROM skills WHERE id=?').get(id) as { body: string } | undefined;
      if (!row) return missing('SKILL_VERSION_NOT_FOUND');
      const versions = (db.prepare('SELECT body FROM skill_versions WHERE skillId=? ORDER BY version DESC LIMIT 1000').all(id) as { body: string }[]).map(item => JSON.parse(item.body));
      return { skill: JSON.parse(row.body), versions };
    },
    'execution.version': ({ id }: { id: string }) => {
      const row = db.prepare('SELECT v.body,s.status FROM skill_versions v JOIN skills s ON s.id=v.skillId WHERE v.id=?').get(id) as { body: string; status: string } | undefined;
      if (!row) return missing('SKILL_VERSION_NOT_FOUND');
      if (row.status === 'source_deleted' || JSON.parse(row.body).invalidated) throw new StorageError('SOURCE_INVALIDATED', 'Skill sources were deleted.', 'SOURCE_DELETED');
      return JSON.parse(row.body);
    },
    'execution.saveDraft': (input: { skillId?: string; expectedRevision?: number; draft: DocumentSkillDraft; idempotencyKey: string }) => db.transaction(() => {
      const cached = receipt('skill.saveDraft', input.idempotencyKey, input); if (cached) return cached;
      let sourceRefs: string[] = [];
      if (input.draft.candidateId) {
        const row = db.prepare('SELECT evidence FROM or_candidates WHERE id=?').get(input.draft.candidateId) as { evidence: string } | undefined;
        if (!row) throw new StorageError('SOURCE_INVALIDATED', '候选来源已失效。', 'SOURCE_DELETED');
        const observations = JSON.parse(row.evidence) as string[];
        sourceRefs = (db.prepare(`SELECT s.id FROM source_refs s JOIN text_evidence t ON t.id=s.textEvidenceId WHERE s.state='valid'
          AND t.captureEventId IN (SELECT value FROM json_each(?))`).all(JSON.stringify(observations)) as { id: string }[]).map(source => source.id);
        if (!sourceRefs.length) throw new StorageError('SOURCE_INVALIDATED', '候选没有有效正文来源。', 'SOURCE_DELETED');
      }
      const old = input.skillId ? db.prepare('SELECT body FROM skills WHERE id=?').get(input.skillId) as { body: string } | undefined : undefined;
      if (input.skillId && !old) return missing('SKILL_VERSION_NOT_FOUND');
      const previous = old && JSON.parse(old.body) as DocumentSkill;
      if (previous && previous.draftRevision !== input.expectedRevision) throw new StorageError('STALE_REVISION', '规则已更新，请重新读取。');
      const skill: DocumentSkill & { sourceRefs: string[] } = { id: previous?.id ?? randomUUID(), draftRevision: (previous?.draftRevision ?? 0) + 1,
        status: 'draft', draft: input.draft, currentVersionId: previous?.currentVersionId ?? null, sourceRefs };
      if (!db.prepare('SELECT 1 FROM document_targets WHERE id=?').get(skill.draft.targetId)) return missing('TARGET_NOT_FOUND');
      db.prepare('INSERT INTO skills VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET draftRevision=excluded.draftRevision,status=excluded.status,body=excluded.body')
        .run(skill.id, skill.draftRevision, skill.status, JSON.stringify(skill));
      putReceipt('skill.saveDraft', input.idempotencyKey, input, skill); host.bump(); return skill;
    })(),
    'execution.publish': (input: { skillId: string; expectedRevision: number; idempotencyKey: string }) => db.transaction(() => {
      const cached = receipt('skill.publishVersion', input.idempotencyKey, input); if (cached) return cached;
      const row = db.prepare('SELECT body FROM skills WHERE id=?').get(input.skillId) as { body: string } | undefined;
      if (!row) return missing('SKILL_VERSION_NOT_FOUND');
      const skill = JSON.parse(row.body) as DocumentSkill;
      if (skill.status === 'source_deleted') throw new StorageError('SOURCE_INVALIDATED', 'Skill sources were deleted.', 'SOURCE_DELETED');
      if (skill.draftRevision !== input.expectedRevision) throw new StorageError('STALE_REVISION', '规则已更新，请重新确认。');
      const number = (db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM skill_versions WHERE skillId=?').get(skill.id) as { version: number }).version;
      const version: DocumentSkillVersion = { id: randomUUID(), skillId: skill.id, version: number, draft: skill.draft, contentHash: digest(skill.draft), createdAt: Date.now() };
      db.prepare('INSERT INTO skill_versions VALUES(?,?,?,?)').run(version.id, version.skillId, version.version, JSON.stringify(version));
      skill.status = 'ready'; skill.currentVersionId = version.id; skill.draftRevision++;
      db.prepare('UPDATE skills SET status=?,draftRevision=?,body=? WHERE id=?').run(skill.status, skill.draftRevision, JSON.stringify(skill), skill.id);
      putReceipt('skill.publishVersion', input.idempotencyKey, input, version); host.bump(); return version;
    })(),
    'execution.sources': ({ ids, limit }: { ids?: string[]; limit?: number } = {}) => {
      const sources = sourceRows(ids, limit ?? (ids ? 2000 : 100));
      if (ids && (new Set(ids).size !== ids.length || sources.length !== ids.length)) throw new StorageError('SOURCE_INVALIDATED', '所选正文来源已失效或不在当前范围内。', 'SOURCE_DELETED');
      return { sources, sourceGeneration: generation() };
    },
    'execution.authorize': ({ id }: { id: string }) => sourcesValid(loadRun(id)),
    'execution.run': ({ id }: { id: string }) => loadRun(id),
    'execution.runs': () => (db.prepare('SELECT body FROM runs ORDER BY createdAt DESC LIMIT 100').all() as { body: string }[]).map(row => JSON.parse(row.body)),
    'execution.receipt': ({ scope, key, payload }: { scope: string; key: string; payload: unknown }) => receipt(scope, key, payload) ?? null,
    'execution.saveReceipt': ({ scope, key, payload, result }: { scope: string; key: string; payload: unknown; result: unknown }) => db.transaction(() => {
      const cached = receipt(scope, key, payload); if (cached) return cached;
      putReceipt(scope, key, payload, result); return result;
    })(),
    'execution.createRun': ({ record, key, payload, result }: { record: ExecutionRunRecord; key: string; payload: unknown; result: unknown }) => db.transaction(() => {
      const cached = receipt('run.prepare', key, payload); if (cached) return cached;
      if (!sourcesValid(record)) throw new StorageError('SOURCE_INVALIDATED', '所选正文来源已变化。', 'SOURCE_DELETED');
      const view = record.view;
      db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)').run(view.runId, view.state, view.generation, view.skillVersionId, view.targetId, record.sourceGeneration, JSON.stringify(record), view.createdAt, view.updatedAt);
      for (const source of record.sourceRevisions) db.prepare('INSERT INTO run_sources VALUES(?,?,?)').run(view.runId, source.sourceRefId, source.revision);
      putReceipt('run.prepare', key, payload, result); host.bump(); return result;
    })(),
    'execution.updateRun': ({ record, expectedGeneration, expectedStates, authorize = false, command }: {
      record: ExecutionRunRecord; expectedGeneration: number; expectedStates: string[]; authorize?: boolean;
      command?: { scope: string; key: string; payload: unknown; result: unknown };
    }) => db.transaction(() => {
      if (command) { const cached = receipt(command.scope, command.key, command.payload); if (cached) return cached; }
      const old = loadRun(record.view.runId);
      if (old.view.generation !== expectedGeneration || !expectedStates.includes(old.view.state)) throw new StorageError('STALE_REVISION', '任务阶段已变化，请重新读取。', 'GENERATION_MISMATCH');
      if (authorize && !sourcesValid(old)) throw new StorageError('SOURCE_INVALIDATED', '所选正文来源已变化。', 'SOURCE_DELETED');
      const view = record.view;
      db.prepare('UPDATE runs SET status=?,generation=?,body=?,updatedAt=? WHERE id=?').run(view.state, view.generation, JSON.stringify(record), view.updatedAt, view.runId);
      if (command) putReceipt(command.scope, command.key, command.payload, command.result);
      host.bump(); return command ? command.result : record;
    })(),
    'execution.operation': ({ id, key, targetId }: { id?: string; key?: string; targetId?: string }) => {
      const row = (id ? db.prepare('SELECT body FROM document_operations WHERE id=?').get(id) :
        db.prepare('SELECT body FROM document_operations WHERE targetId=? AND idempotencyKey=?').get(targetId, key)) as { body: string | null } | undefined;
      return row?.body ? JSON.parse(row.body) : null;
    },
    'execution.pendingOperations': () => (db.prepare("SELECT body FROM document_operations WHERE status IN ('applying','verifying') AND body IS NOT NULL").all() as { body: string }[]).map(row => JSON.parse(row.body)),
    'execution.saveOperation': (operation: LocalDocumentOperation) => db.transaction(() => {
      if (['succeeded', 'no_change'].includes(operation.state) && !sourcesValid(loadRun(operation.runId))) {
        operation = { ...operation, state: 'source_invalidated', detailCode: 'SOURCE_DELETED' };
      }
      const id = operation.id;
      const previous = db.prepare('SELECT id,payloadHash,body FROM document_operations WHERE id=? OR (targetId=? AND idempotencyKey=?)').get(id, operation.targetId, operation.idempotencyKey) as { id: string; payloadHash: string; body: string | null } | undefined;
      if (previous && previous.payloadHash !== operation.requestHash) throw new StorageError('CONFLICT', 'Operation key conflict.', 'IDEMPOTENCY_CONFLICT');
      if (previous && previous.id !== id) return previous.body ? JSON.parse(previous.body) : null;
      db.prepare('INSERT INTO document_operations VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body').run(id, operation.runId, operation.targetId, operation.idempotencyKey, operation.requestHash, operation.state, JSON.stringify(operation));
      return operation;
    })(),
    'execution.capability': ({ body }: { body?: unknown } = {}) => {
      if (body !== undefined) db.prepare("INSERT INTO agent_capabilities VALUES('codex',?) ON CONFLICT(provider) DO UPDATE SET body=excluded.body").run(JSON.stringify(body));
      const row = db.prepare("SELECT body FROM agent_capabilities WHERE provider='codex'").get() as { body: string } | undefined;
      return row ? JSON.parse(row.body) : null;
    },
  };
}
