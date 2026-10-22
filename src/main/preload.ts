import { contextBridge, ipcRenderer } from 'electron';
import type { DomainMethod, MethodInput, MethodOutput, OneRoomApi, Reply, TimelineGesture } from '../shared/contracts';
import type { DomainEvent } from '../shared/schemas';

// Sandboxed preload must remain a single CJS file; runtime schemas stay in main.
const RPC_CHANNEL = 'one-room:invoke', EVENT_CHANNEL = 'one-room:event';
function method<M extends DomainMethod>(name: M) {
  return (payload: MethodInput<M>): Promise<Reply<MethodOutput<M>>> => ipcRenderer.invoke(RPC_CHANNEL, name, { requestId: crypto.randomUUID(), payload });
}
function unwrap<T>(reply: Reply<T>): T {
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data;
}

const api: OneRoomApi = {
  target: { pickLocalMarkdown: method('target.pickLocalMarkdown'), list: method('target.list'), inspect: method('target.inspect'), confirmExclusiveEditing: method('target.confirmExclusiveEditing') },
  skill: { list: method('skill.list'), get: method('skill.get'), saveDraft: method('skill.saveDraft'), publishVersion: method('skill.publishVersion') },
  source: { list: method('source.list') },
  agent: { getStatus: method('agent.getStatus'), check: method('agent.check'), testCapability: method('agent.testCapability') },
  run: { list: method('run.list'), prepare: method('run.prepare'), propose: method('run.propose'), get: method('run.get'), cancel: method('run.cancel'), apply: method('run.apply'), exportPatch: method('run.exportPatch'), verify: method('run.verify') },
  reuse: {
    recordings: async () => unwrap(await method('reuse.recordings')({})),
    recordWorkflow: async input => unwrap(await method('reuse.recordWorkflow')(input)),
    beginRecording: async id => { unwrap(await method('reuse.beginRecording')({ id })); },
    stopRecording: async id => { unwrap(await method('reuse.stopRecording')({ id })); },
    candidates: async () => unwrap(await method('reuse.candidates')({})),
    candidateStatus: async (id, status) => { unwrap(await method('reuse.candidateStatus')({ id, status })); },
    skills: async () => unwrap(await method('reuse.skills')({})),
    saveSkill: async input => unwrap(await method('reuse.saveSkill')(input)),
    agents: async () => unwrap(await method('reuse.agents')({})),
    run: async (skillId, version, parameters) => unwrap(await method('reuse.run')({ skillId, version, parameters })),
    runs: async () => unwrap(await method('reuse.runs')({})),
    cancel: async id => { unwrap(await method('reuse.cancel')({ id })); },
    verify: async id => unwrap(await method('reuse.verify')({ id })),
    acknowledgeRun: async id => { unwrap(await method('reuse.acknowledgeRun')({ id })); },
    rules: async () => unwrap(await method('reuse.rules')({})),
    saveRule: async input => unwrap(await method('reuse.saveRule')(input)),
  },
  app: { getStatus: method('app.getStatus') },
  permissions: { get: method('permissions.get'), openSettings: method('permissions.openSettings') },
  capture: { pause: method('capture.pause'), resume: method('capture.resume') },
  settings: { get: method('settings.get'), updateCaptureScope: method('settings.updateCaptureScope'), updateTextConsent: method('settings.updateTextConsent') },
  model: { getConfig: method('model.getConfig'), saveConfig: method('model.saveConfig'), testConnection: method('model.testConnection'), clearCredential: method('model.clearCredential') },
  activity: { query: method('activity.query'), review: method('activity.review') },
  timeline: { query: method('timeline.query'), resolveCursor: method('timeline.resolveCursor') },
  calendar: { query: method('calendar.query') },
  report: { get: method('report.get'), generate: method('report.generate') },
  history: { previewDelete: method('history.previewDelete'), delete: method('history.delete') },
  gestures: {
    subscribe(listener) {
      const receive = (_event: Electron.IpcRendererEvent, payload: TimelineGesture): void => {
        if (payload?.kind === 'swipe' && ['left', 'right', 'up', 'down'].includes(payload.direction)) listener(payload);
      };
      ipcRenderer.on('one-room:gesture', receive);
      return () => ipcRenderer.removeListener('one-room:gesture', receive);
    },
  },
  events: {
    subscribe(listener) {
      const receive = (_event: Electron.IpcRendererEvent, payload: DomainEvent): void => listener(payload);
      ipcRenderer.on(EVENT_CHANNEL, receive);
      ipcRenderer.send('one-room:subscribe');
      return () => { ipcRenderer.removeListener(EVENT_CHANNEL, receive); };
    },
  },
};
contextBridge.exposeInMainWorld('oneRoom', api);
