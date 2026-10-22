import type { DomainRouter } from '../../main/ipc';
import type { DomainEvents } from '../../main/events';
import { createSnapshotQueries } from './queries';
import type { WorklogReader } from './repository';
import { createReports, type ReportRepository } from './reports';
import { createHistoryDelete, type HistoryRepository, type DurableHistoryRepository } from './history-delete';

export function registerWorklogServices(router: DomainRouter, dependencies: {
  reader: WorklogReader; reports?: ReportRepository; history?: HistoryRepository | DurableHistoryRepository;
  events: DomainEvents; currentRevision: () => Promise<number>;
}): void {
  const queries = createSnapshotQueries(dependencies.reader);
  router.register('timeline.query', async input => { const data = await queries.timeline(input); return { data, dataRevision: data.dataRevision }; });
  router.register('timeline.resolveCursor', async input => { const data = await queries.cursor(input); return { data, dataRevision: data.dataRevision }; });
  router.register('calendar.query', async input => { const data = await queries.calendar(input); return { data, dataRevision: data.dataRevision }; });
  if (dependencies.reports) {
    const reports = createReports(dependencies.reports);
    router.register('report.get', async input => ({ data: await reports.get(input), dataRevision: await dependencies.currentRevision() }));
    router.register('report.generate', async input => {
      const data = await reports.generate(input), dataRevision = await dependencies.currentRevision();
      dependencies.events.publish('report.changed', data.report?.id ?? 'report', dataRevision);
      return { data, dataRevision };
    });
  }
  if (dependencies.history) {
    const history = createHistoryDelete(dependencies.history);
    router.register('history.previewDelete', async input => { const data = await history.preview(input); return { data, dataRevision: data.dataRevision }; });
    router.register('history.delete', async input => {
      const data = await history.delete(input);
      dependencies.events.publish('source.invalidated', input.deletionRef, data.dataRevision);
      dependencies.events.publish('timeline.changed', input.deletionRef, data.dataRevision);
      dependencies.events.publish('settings.changed', input.deletionRef, data.dataRevision);
      dependencies.events.publish('capture.status', input.deletionRef, data.dataRevision);
      dependencies.events.publish('report.changed', input.deletionRef, data.dataRevision);
      return { data, dataRevision: data.dataRevision };
    });
  }
}
