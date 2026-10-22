import { app, dialog } from 'electron';
import { join } from 'node:path';
import type { DomainRouter } from './ipc';
import type { DomainEvents } from './events';
import type { DatabaseClient } from '../services/storage/client';
import { CodexAdapter } from '../services/agents/codex';
import type { CapabilityRecord } from '../services/agents/types';
import { DocumentRunService } from '../services/agents/runs';

export async function registerExecutionServices(router: DomainRouter, database: DatabaseClient, events: DomainEvents): Promise<DocumentRunService> {
  const capability = (await database.call<CapabilityRecord | null>('execution.capability')).data;
  const agent = new CodexAdapter({ runRoot: join(app.getPath('userData'), 'document-runs'), ...(capability ? { capability } : {}) });
  const service = new DocumentRunService({ database, agent, events, dialogs: {
    pickMarkdown: async () => {
      const result = await dialog.showOpenDialog({ title: '选择目标 Markdown 文档', properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    savePatch: async displayName => {
      const result = await dialog.showSaveDialog({ title: '导出审核差异', defaultPath: `${displayName}.patch`, filters: [{ name: 'Patch', extensions: ['patch'] }] });
      return result.canceled ? null : result.filePath ?? null;
    },
  } });
  await service.initialize();
  const wrap = async <T>(data: T) => ({ data, dataRevision: (await database.call('bootstrap')).dataRevision });
  router.register('target.list', async () => wrap(await service.listTargets()));
  router.register('target.pickLocalMarkdown', async () => wrap(await service.pickTarget()));
  router.register('target.inspect', async input => wrap(await service.inspectTarget(input.targetId)));
  router.register('target.confirmExclusiveEditing', async input => wrap(await service.confirmExclusive(input)));
  router.register('skill.list', async () => wrap(await service.listSkills()));
  router.register('skill.get', async input => wrap(await service.getSkill(input.skillId)));
  router.register('skill.saveDraft', async input => wrap(await service.saveDraft(input)));
  router.register('skill.publishVersion', async input => wrap(await service.publish(input)));
  router.register('source.list', async input => wrap(await service.listSources(input.limit)));
  router.register('agent.getStatus', async () => wrap(await service.agents()));
  router.register('agent.check', async () => wrap(await service.agents(true)));
  router.register('agent.testCapability', async () => wrap(await service.testCapability()));
  router.register('run.list', async () => wrap(await service.listRuns()));
  router.register('run.prepare', async input => wrap(await service.prepare(input)));
  router.register('run.propose', async input => wrap(await service.propose(input)));
  router.register('run.get', async input => wrap(await service.getRun(input.runId)));
  router.register('run.verify', async input => wrap(await service.verify(input.runId)));
  router.register('run.cancel', async input => wrap(await service.cancel(input)));
  router.register('run.apply', async input => wrap(await service.apply(input)));
  router.register('run.exportPatch', async input => wrap(await service.exportPatch(input)));
  return service;
}
