import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, FilePlus2, FolderOpen, LoaderCircle, Plus, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import type { MethodOutput, OneRoomApi } from '../../shared/contracts';
import type { AgentCapabilityView, DocumentSkill, DocumentSkillDraft, DocumentSkillVersion, DocumentTarget, RunView } from '../../shared/execution-schemas';
import type { Candidate } from '../../services/reuse/types';
import { IconButton } from '../components/IconButton';
import { errorMessage, unwrap } from '../lib/desktop';
import { formatDateTime } from '../lib/time';
import { RunReview, runStateLabels } from '../runs/RunReview';
import './document-workbench.css';

type Props = { api: OneRoomApi; candidate?: Candidate | null; onCandidateUsed?: () => void };
const emptyDraft = (): DocumentSkillDraft => ({ title: '', kind: 'document', targetId: '', sectionRef: '',
  formatRules: '保留当前标题、列表结构与非目标章节。', instructions: '', deduplication: '合并相同事实，已存在的内容不重复添加。' });
const kindLabels = { daily: '日报', weekly: '周报', document: '普通文档' } as const;

export function DocumentWorkbench({ api, candidate, onCandidateUsed }: Props) {
  const [targets, setTargets] = useState<DocumentTarget[]>([]), [skills, setSkills] = useState<DocumentSkill[]>([]), [runs, setRuns] = useState<RunView[]>([]);
  const [sources, setSources] = useState<MethodOutput<'source.list'>>([]), [agents, setAgents] = useState<AgentCapabilityView[]>([]);
  const [draft, setDraft] = useState<DocumentSkillDraft>(emptyDraft), [saved, setSaved] = useState<DocumentSkill | null>(null);
  const [inspection, setInspection] = useState<MethodOutput<'target.inspect'> | null>(null), [versions, setVersions] = useState<DocumentSkillVersion[]>([]);
  const [versionId, setVersionId] = useState(''), [sourceIds, setSourceIds] = useState<string[]>([]), [runId, setRunId] = useState('');
  const [confirmations, setConfirmations] = useState({ target: false, section: false, rules: false });
  const [busy, setBusy] = useState<string | null>(null), [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const loadSequence = useRef(0), inspectSequence = useRef(0), editSequence = useRef(0), usedCandidate = useRef('');
  const available = !!api.target && !!api.skill && !!api.source && !!api.run && !!api.agent;
  const load = useCallback(async () => {
    if (!api.target || !api.skill || !api.source || !api.run || !api.agent) return;
    const request = ++loadSequence.current;
    try {
      const [targetReply, skillReply, sourceReply, runReply, agentReply] = await Promise.all([api.target.list({}), api.skill.list({}), api.source.list({ limit: 100 }), api.run.list({}), api.agent.getStatus({})]);
      const next = { targets: unwrap(targetReply), skills: unwrap(skillReply), sources: unwrap(sourceReply), runs: unwrap(runReply), agents: unwrap(agentReply) };
      if (request !== loadSequence.current) return;
      setTargets(next.targets); setSkills(next.skills); setSources(next.sources); setRuns(next.runs); setAgents(next.agents);
      setRunId(current => current || next.runs[0]?.runId || '');
      setSaved(current => current ? { ...current, status: next.skills.find(skill => skill.id === current.id)?.status ?? current.status } : current);
      setSourceIds(ids => ids.filter(id => next.sources.some(source => source.sourceRefId === id)));
    } catch (error) { if (request === loadSequence.current) setMessage({ text: errorMessage(error), error: true }); }
  }, [api.target, api.skill, api.source, api.run, api.agent]);
  useEffect(() => { void load(); return () => { loadSequence.current += 1; }; }, [load]);
  useEffect(() => api.events.subscribe(event => {
    if (event.type === 'source.invalidated') { setSources([]); setSourceIds([]); setConfirmations({ target: false, section: false, rules: false }); void load(); }
    else if (event.type === 'run.changed' || event.type === 'skill.changed') void load();
  }), [api.events, load]);
  useEffect(() => {
    const request = ++inspectSequence.current;
    setInspection(null); setConfirmations({ target: false, section: false, rules: false });
    if (draft.targetId && api.target) void api.target.inspect({ targetId: draft.targetId }).then(reply => {
      const result = unwrap(reply); if (request === inspectSequence.current) setInspection(result);
    }).catch(error => { if (request === inspectSequence.current) setMessage({ text: errorMessage(error), error: true }); });
    return () => { inspectSequence.current += 1; };
  }, [api.target, draft.targetId]);
  useEffect(() => {
    if (!candidate || candidate.id === usedCandidate.current) return;
    usedCandidate.current = candidate.id;
    editSequence.current += 1;
    if (candidate.kind !== 'document') { setMessage({ text: '配券与策略仅支持规则预览。', error: true }); onCandidateUsed?.(); return; }
    setSaved(null); setVersions([]); setVersionId(''); setConfirmations({ target: false, section: false, rules: false });
    setDraft({ ...emptyDraft(), title: candidate.title, kind: /周报/.test(candidate.title) ? 'weekly' : /日报/.test(candidate.title) ? 'daily' : 'document',
      instructions: candidate.pattern?.steps.join('\n') || candidate.title, candidateId: candidate.id });
    onCandidateUsed?.();
  }, [candidate, onCandidateUsed]);

  const change = <K extends keyof DocumentSkillDraft>(key: K, value: DocumentSkillDraft[K]) => {
    editSequence.current += 1;
    setDraft(current => ({ ...current, [key]: value, ...(key === 'targetId' ? { sectionRef: '' } : {}) }));
    setConfirmations({ target: false, section: false, rules: false }); setMessage(null);
  };
  const action = async (name: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(name); setMessage(null);
    try { await operation(); await load(); }
    catch (error) { setMessage({ text: errorMessage(error), error: true }); }
    finally { setBusy(null); }
  };
  const chooseSkill = async (id: string) => {
    if (!api.skill) return;
    if (!id) { setSaved(null); setDraft(emptyDraft()); setVersions([]); setVersionId(''); setConfirmations({ target: false, section: false, rules: false }); return; }
    const request = ++editSequence.current;
    await action('skill', async () => {
      const result = unwrap(await api.skill!.get({ skillId: id }));
      if (request !== editSequence.current) return;
      setSaved(result.skill); setDraft(result.skill.draft); setVersions(result.versions);
      setVersionId(result.skill.currentVersionId ?? ''); setConfirmations({ target: false, section: false, rules: false });
    });
  };
  const selectedSection = inspection?.sections.find(section => section.sectionRef === draft.sectionRef);
  const selectedVersion = versions.find(version => version.id === versionId);
  const unsaved = !saved || JSON.stringify(saved.draft) !== JSON.stringify(draft);
  const readyToSave = !!draft.title.trim() && !!draft.targetId && !!selectedSection && !!draft.instructions.trim() && !!draft.formatRules.trim() && !!draft.deduplication.trim();
  const publishedMatches = !!selectedVersion && JSON.stringify(selectedVersion.draft) === JSON.stringify(draft);
  const codex = agents.find(agent => agent.provider === 'codex');
  if (!available) return <section className="document-workbench"><p className="subtle-text">文档复用尚未连接。</p></section>;
  return <div className="document-workbench">
    <header className="document-heading"><div><h1>文档复用</h1><p className="subtle-text">{skills.length} 个规则 · {runs.length} 次任务</p></div><div className="document-toolbar">
      <IconButton label="刷新文档工作台" disabled={!!busy} onClick={() => void load()}><RefreshCw size={15} /></IconButton>
      <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void chooseSkill('')}><Plus size={15} />新建规则</button>
    </div></header>
    {message && <p className={`document-message ${message.error ? 'is-error' : 'is-success'}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    <section className="document-section" aria-label="文档规则">
      <div className="document-heading"><h2>文档规则</h2><span className="subtle-text">{saved ? saved.status === 'ready' ? '已发布' : saved.status === 'source_deleted' ? '来源已删除' : '草稿' : '新草稿'}</span></div>
      <div className="document-fields document-two-columns">
        <label className="document-field"><span>已保存规则</span><select aria-label="已保存规则" value={saved?.id ?? ''} disabled={!!busy} onChange={event => void chooseSkill(event.target.value)}><option value="">新规则</option>{skills.map(skill => <option key={skill.id} value={skill.id}>{skill.draft.title}{skill.status === 'source_deleted' ? ' · 来源已删除' : ''}</option>)}</select></label>
        <label className="document-field"><span>类型</span><select aria-label="类型" value={draft.kind} disabled={!!busy} onChange={event => change('kind', event.target.value as DocumentSkillDraft['kind'])}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <label className="document-field"><span>名称</span><input value={draft.title} maxLength={256} disabled={!!busy} onChange={event => change('title', event.target.value)} /></label>
      <div className="document-target-row"><label className="document-field"><span>本地文档</span><select aria-label="本地文档" value={draft.targetId} disabled={!!busy} onChange={event => change('targetId', event.target.value)}><option value="">选择已注册文档</option>{targets.map(target => <option value={target.id} key={target.id}>{target.displayName}</option>)}</select></label>
        <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void action('pick', async () => {
          const result = unwrap(await api.target!.pickLocalMarkdown({}));
          if (result.selected) { change('targetId', result.target.id); setTargets(current => [...current.filter(target => target.id !== result.target.id), result.target]); }
        })}><FolderOpen size={15} />选择文件</button>
      </div>
      <label className="document-field"><span>目标章节</span><select aria-label="目标章节" value={draft.sectionRef} disabled={!!busy || !inspection} onChange={event => change('sectionRef', event.target.value)}><option value="">选择要更新的章节</option>{inspection?.sections.map(section => <option key={section.sectionRef} value={section.sectionRef}>{section.label}</option>)}</select></label>
      {selectedSection && <details className="document-current" open><summary>当前章节 · {inspection?.newline}{inspection?.bom ? ' · BOM' : ''}</summary><pre className="document-preview" tabIndex={0} aria-label="当前目标章节">{selectedSection.text}</pre></details>}
      <label className="document-field"><span>更新要求</span><textarea rows={3} value={draft.instructions} maxLength={8192} disabled={!!busy} onChange={event => change('instructions', event.target.value)} /></label>
      <div className="document-fields document-two-columns"><label className="document-field"><span>格式规则</span><textarea rows={3} value={draft.formatRules} maxLength={8192} disabled={!!busy} onChange={event => change('formatRules', event.target.value)} /></label><label className="document-field"><span>去重规则</span><textarea rows={3} value={draft.deduplication} maxLength={4096} disabled={!!busy} onChange={event => change('deduplication', event.target.value)} /></label></div>
      <div className="document-actions"><button type="button" className="secondary-button" disabled={!!busy || !readyToSave || !unsaved} onClick={() => void action('save', async () => {
        const request = editSequence.current;
        const result = unwrap(await api.skill!.saveDraft({ ...(saved ? { skillId: saved.id, expectedRevision: saved.draftRevision } : {}), draft, idempotencyKey: crypto.randomUUID() }));
        if (request !== editSequence.current) return;
        setSaved(result); setMessage({ text: '草稿已保存。', error: false }); setConfirmations({ target: false, section: false, rules: false });
      })}>{busy === 'save' ? <LoaderCircle size={15} className="is-spinning" /> : <Save size={15} />}保存草稿</button></div>
      <fieldset className="document-publish"><legend>发布确认</legend>{([['target', '目标文档正确'], ['section', '章节范围正确'], ['rules', '格式与去重规则正确']] as const).map(([key, label]) => <label key={key} className="document-check"><input type="checkbox" checked={confirmations[key]} disabled={!!busy || !saved || unsaved || saved.status === 'source_deleted'} onChange={event => setConfirmations(current => ({ ...current, [key]: event.target.checked }))} /><span>{label}</span></label>)}</fieldset>
      <div className="document-actions"><button type="button" className="primary-button" disabled={!!busy || !saved || unsaved || !readyToSave || !Object.values(confirmations).every(Boolean) || saved.status === 'source_deleted'} onClick={() => void action('publish', async () => {
        if (!saved) return;
        const request = editSequence.current;
        const version = unwrap(await api.skill!.publishVersion({ skillId: saved.id, expectedRevision: saved.draftRevision, confirmations: { target: true, section: true, rules: true }, idempotencyKey: crypto.randomUUID() }));
        const detail = unwrap(await api.skill!.get({ skillId: saved.id })); if (request !== editSequence.current) return;
        setSaved(detail.skill); setVersions(detail.versions); setVersionId(version.id);
        setConfirmations({ target: false, section: false, rules: false }); setMessage({ text: `已发布版本 ${version.version}。`, error: false });
      })}><ShieldCheck size={15} />发布新版本</button></div>
    </section>
    <section className="document-section" aria-label="准备文档更新">
      <div className="document-heading"><h2>准备更新</h2><div className="document-toolbar"><span className="document-agent">Codex · {codex?.enabled ? '可用' : codex?.authState === 'missing' ? '未登录' : codex?.capability === 'blocked' ? '能力未通过' : '待验证'}</span><span className="document-agent is-disabled" aria-disabled="true">Claude · 暂未接入</span></div></div>
      <label className="document-field"><span>不可变规则版本</span><select aria-label="不可变规则版本" value={versionId} disabled={!!busy || !versions.length} onChange={event => {
        const version = versions.find(item => item.id === event.target.value); setVersionId(event.target.value);
        if (version) { editSequence.current += 1; setDraft(version.draft); setConfirmations({ target: false, section: false, rules: false }); }
      }}><option value="">选择已发布版本</option>{versions.map(version => <option key={version.id} value={version.id}>v{version.version} · {formatDateTime(version.createdAt)}</option>)}</select></label>
      {selectedVersion && <details className="document-metadata"><summary>版本内容</summary><pre className="document-preview" tabIndex={0}>{JSON.stringify(selectedVersion.draft, null, 2)}</pre></details>}
      <div className="document-heading document-source-heading"><h3>正文来源</h3><span className="subtle-text">已选 {sourceIds.length} / {sources.length}</span></div>
      <div className="document-source-list">{sources.length ? sources.map(source => <label className="document-source" key={source.sourceRefId}>
        <input type="checkbox" checked={sourceIds.includes(source.sourceRefId)} disabled={!!busy} onChange={event => setSourceIds(ids => event.target.checked ? [...ids, source.sourceRefId] : ids.filter(id => id !== source.sourceRefId))} />
        <span><strong>{source.label || '正文记录'}</strong><small>{formatDateTime(source.observedAt)}</small><span className="document-source-text">{source.preview}</span></span>
      </label>) : <p className="subtle-text">暂无可用正文来源</p>}</div>
      <div className="document-actions"><button type="button" className="primary-button" disabled={!!busy || !selectedVersion || !publishedMatches || !sourceIds.length || !selectedSection} onClick={() => void action('prepare', async () => {
        if (!selectedVersion) return;
        const result = unwrap(await api.run!.prepare({ provider: 'codex', skillVersionId: selectedVersion.id, targetId: selectedVersion.draft.targetId,
          sectionRef: selectedVersion.draft.sectionRef, sourceRefs: sourceIds, idempotencyKey: crypto.randomUUID() }));
        setRunId(result.runId);
      })}>{busy === 'prepare' ? <LoaderCircle size={15} className="is-spinning" /> : <FilePlus2 size={15} />}准备输入审核</button></div>
    </section>
    {runs.length > 0 && <section className="document-section" aria-label="历史任务"><div className="document-heading"><h2>任务记录</h2><span className="subtle-text">{runs.length}</span></div><div className="document-run-list">{runs.map(run => <button type="button" className={`document-run-row ${run.runId === runId ? 'is-selected' : ''}`} key={run.runId} onClick={() => setRunId(run.runId)}>
      <span><strong>{targets.find(target => target.id === run.targetId)?.displayName ?? '文档任务'}</strong><small>{formatDateTime(run.createdAt)}</small></span><span>{runStateLabels[run.state]}</span><ArrowRight size={14} />
    </button>)}</div></section>}
    {runId && <RunReview key={runId} api={api} runId={runId} targets={targets} codexReady={!!codex?.enabled} onChanged={() => void load()} />}
  </div>;
}
