import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  Clock,
  Eye,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  X,
  Pencil,
  Bot,
} from 'lucide-react'
import type {
  AgentRun,
  AgentStatus,
  Candidate,
  SkillInput,
  SkillVersion,
  StrategyRule,
  ReuseAPI,
} from '../../services/reuse/types'
import { draftSkill } from '../../services/reuse/types'
import './sop-workbench.css'
import { WorkflowRecorder } from './WorkflowRecorder'
import type { WorkflowRecording } from '../../services/reuse/workflow-types'

const defaults: SkillInput = {
  title: '',
  purpose: '',
  target: '',
  scope: '',
  format: '按录制顺序执行，页面不匹配时停止',
  variables: '操作对象、输入参数',
  sources: '用户确认的本机录制',
  dedup: '结果不明时不自动重试，先核验实际结果',
  success: '完成全部步骤并核验实际结果',
}
const fields: [keyof SkillInput, string][] = [
  ['title', '名称'],
  ['purpose', '用途'],
  ['target', '目标公司 Docs URL'],
  ['scope', '目标章节与范围'],
  ['format', '格式规则'],
  ['variables', '变量'],
  ['sources', '事实来源范围'],
  ['dedup', '去重条件'],
  ['success', '成功标准'],
]
const stateLabels: Record<AgentRun['state'], string> = {
  queued: '排队',
  reading: '读取目标',
  generating: '准备步骤',
  applying: '执行中',
  verifying: '回读核验',
  succeeded: '成功',
  no_change: '无需修改',
  failed: '失败',
  canceled: '已取消',
  conflict: '冲突',
  needs_verification: '结果待核验',
  reviewed: '已人工核验',
}
export function SopWorkbench({ api, onLocalSkill }: { api: ReuseAPI; onLocalSkill?: (candidate: Candidate) => void }): React.JSX.Element {
  const [candidates, setCandidates] = useState<Candidate[]>([]),
    [skills, setSkills] = useState<SkillVersion[]>([]),
    [runs, setRuns] = useState<AgentRun[]>([]),
    [agents, setAgents] = useState<AgentStatus[]>([])
  const [form, setForm] = useState<SkillInput | null>(null),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false),
    [filter, setFilter] = useState<Candidate['status']>('new')
  const [details, setDetails] = useState<string | null>(null)
  const [manualRun, setManualRun] = useState<AgentRun | null>(null)
  const [recordings, setRecordings] = useState<WorkflowRecording[]>([])
  const [mode, setMode] = useState<'codex' | 'openadapt'>('codex')
  const [runForm, setRunForm] = useState<{
    skill: SkillVersion
    parameters: Record<string, string>
  } | null>(null)
  const edit = (
    input: SkillInput,
    engine: 'codex' | 'openadapt' = input.workflow ? 'openadapt' : 'codex',
  ) => {
    setMode(engine)
    setForm(input)
  }
  const [rules, setRules] = useState<StrategyRule[]>([]),
    [rule, setRule] = useState<Omit<StrategyRule, 'id' | 'createdAt'> | null>(null)
  useEffect(() => {
    if (!form && !rule && !runForm && !manualRun) return
    const previous = document.activeElement as HTMLElement | null
    const dialog = document.querySelector<HTMLElement>('.or-modal')
    const controls = () => [
      ...(dialog?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)',
      ) || []),
    ]
    controls()
      .find((element) => element.tagName !== 'BUTTON')
      ?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) {
        event.preventDefault()
        setForm(null)
        setRule(null)
        setRunForm(null)
        setManualRun(null)
      }
      if (event.key !== 'Tab') return
      const items = controls(),
        first = items[0],
        last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', keydown)
      document.body.style.overflow = overflow
      previous?.focus()
    }
  }, [Boolean(form), Boolean(rule), Boolean(runForm), Boolean(manualRun), saving])
  const load = useCallback(async () => {
    try {
      const [c, s, r, preview, recordings] = await Promise.all([
        api.candidates(),
        api.skills(),
        api.runs(),
        api.rules(),
        api.recordings(),
      ])
      setCandidates(c)
      setSkills(s)
      setRuns(r)
      setRules(preview)
      setRecordings(recordings)
    } catch (e) {
      setError(String(e))
    }
  }, [api])
  const detect = useCallback(() => {
    void api
      .agents()
      .then(setAgents)
      .catch((e) => setError(String(e)))
  }, [api])
  useEffect(() => {
    void load()
    detect()
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  }, [load, detect])
  const action = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn()
      await load()
      setError('')
      return true
    } catch (e) {
      setError(String(e))
      return false
    }
  }
  const latest = skills.filter(
    (s) => !skills.some((other) => other.id === s.id && other.version > s.version),
  )
  const fieldLabel = (key: keyof SkillInput, label: string): string =>
    mode === 'openadapt' && key === 'target'
      ? '目标页面地址'
      : mode === 'openadapt' && key === 'scope'
        ? '操作范围'
        : label
  return (
    <div className="or-page">
      <header className="or-header">
        <div>
          <h1>SOP 工作台</h1>
          <span className="or-muted">
            {latest.length} 个流程 · {candidates.filter((c) => c.status === 'new').length} 个候选
          </span>
        </div>
        <button className="or-primary" onClick={() => edit({ ...defaults }, 'openadapt')}>
          <Plus />
          新建 SOP
        </button>
      </header>
      {error && (
        <div className="or-error" role="alert">
          {error}
        </div>
      )}
      <section className="or-section">
        <h2>执行器</h2>
        {agents.length ? (
          agents.map((agent) => (
            <div className="or-row" key={agent.id}>
              <Bot />
              <strong>
                {agent.id === 'codex'
                  ? 'Codex'
                  : agent.id === 'openadapt'
                    ? '本地流程引擎'
                    : 'Claude'}
              </strong>
              <span className="or-muted">{agent.detail}</span>
              <button disabled={agent.id === 'claude'} onClick={detect}>
                <RefreshCw />
                检测
              </button>
            </div>
          ))
        ) : (
          <p className="or-muted">检测环境中…</p>
        )}
      </section>
      <WorkflowRecorder api={api} recordings={recordings} refresh={load} onError={setError} />
      <section className="or-section">
        <div className="or-header">
          <h2>发现候选</h2>
          <select
            aria-label="候选状态"
            value={filter}
            onChange={(e) => setFilter(e.target.value as Candidate['status'])}
          >
            {Object.entries({
              new: '待处理',
              accepted: '已接受',
              ignored: '已忽略',
              later: '稍后',
            }).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        {!candidates.some((c) => c.status === filter) && <p className="or-muted">暂无候选</p>}
        {candidates
          .filter((c) => c.status === filter)
          .map((c) => (
            <div className="or-row" key={c.id}>
              <div className="or-row-content">
                <strong>{c.title}</strong>
                <p>
                  {c.instances} 次独立操作 ·{' '}
                  {c.target ||
                    (c.kind === 'strategy'
                      ? '策略流程'
                      : c.kind === 'workflow'
                        ? '通用操作流程'
                        : '待确认目标文档')}
                </p>
                {c.pattern && (
                  <>
                    <p className="or-muted">
                      {c.pattern.source === 'cluster' ? '语义任务聚类' : '操作序列匹配'}
                    </p>
                    <ol>
                      {c.pattern.steps.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>
                    <p>{c.pattern.variables.join('、')}</p>
                    <details>
                      <summary>重复实例</summary>
                      {c.pattern.occurrences.map((item) => (
                        <p key={item.id}>
                          {new Date(item.start).toLocaleString()} · {item.object}
                        </p>
                      ))}
                    </details>
                  </>
                )}
                <details>
                  <summary>来源任务</summary>
                  <pre>{c.evidence.join('\n')}</pre>
                </details>
              </div>
              {c.kind !== 'strategy' && onLocalSkill && <button title="选择本地 Markdown 目标并确认规则" onClick={() => onLocalSkill(c)}><Plus />本地文档 Skill</button>}
              {c.status === 'new' ? (
                <>
                  <button
                    title="接受并确认规则"
                    onClick={() =>
                      c.kind === 'strategy'
                        ? setRule({
                            title: c.title,
                            steps: c.pattern?.steps.join('\n') || '',
                            variables: c.pattern?.variables.join('、') || '',
                            prerequisites: '',
                            approvals: '',
                            candidateId: c.id,
                          })
                        : edit(draftSkill(c), c.kind === 'workflow' ? 'openadapt' : 'codex')
                    }
                  >
                    <Check />
                    沉淀规则
                  </button>
                  <button
                    title="稍后"
                    onClick={() => void action(() => api.candidateStatus(c.id, 'later'))}
                  >
                    <Clock />
                  </button>
                  <button
                    title="忽略"
                    onClick={() => void action(() => api.candidateStatus(c.id, 'ignored'))}
                  >
                    <X />
                  </button>
                </>
              ) : (
                <button onClick={() => void action(() => api.candidateStatus(c.id, 'new'))}>
                  <RotateCcw />
                  恢复
                </button>
              )}
            </div>
          ))}
      </section>
      <section className="or-section">
        <h2>已发布 SOP</h2>
        {!latest.length && <p className="or-muted">暂无 SOP</p>}
        {latest.map((s) => (
          <div className="or-row" key={s.id}>
            <div className="or-row-content">
              <strong>
                {s.title} · v{s.version}
              </strong>
              <p>{s.target}</p>
              <p>{s.scope}</p>
              <details>
                <summary>版本和规则</summary>
                <pre>
                  {skills
                    .filter((v) => v.id === s.id)
                    .map(
                      (v) =>
                        `v${v.version} · ${new Date(v.createdAt).toLocaleString()}\n${JSON.stringify(v, null, 2)}`,
                    )
                    .join('\n\n')}
                </pre>
              </details>
            </div>
            <button title="发布新版本" onClick={() => edit(s)}>
              <Pencil />
            </button>
            <button
              className="or-primary"
              disabled={!agents.find((a) => a.id === (s.workflow ? 'openadapt' : 'codex'))?.enabled}
              onClick={() =>
                s.workflow
                  ? setRunForm({ skill: s, parameters: { ...s.workflow.parameters } })
                  : void action(() => api.run(s.id, s.version))
              }
            >
              <Play />
              复用 v{s.version}
            </button>
          </div>
        ))}
      </section>
      <section className="or-section">
        <h2>执行记录</h2>
        {!runs.length && <p className="or-muted">暂无执行记录</p>}
        {runs.map((run) => (
          <div className="or-row" key={run.id}>
            <div className="or-row-content">
              <strong>
                {stateLabels[run.state]} ·{' '}
                {skills.find((s) => s.id === run.skillId && s.version === run.version)?.title ||
                  run.skillId}{' '}
                v{run.version}
              </strong>
              <p>
                {new Date(run.createdAt).toLocaleString()} · {run.target}
              </p>
              {run.error && <p className="or-error">{run.error}</p>}
            </div>
            <button title="查看回执" onClick={() => setDetails(details === run.id ? null : run.id)}>
              <Eye />
            </button>
            {['queued', 'reading', 'generating', 'applying', 'verifying'].includes(run.state) && (
              <button title="取消" onClick={() => void action(() => api.cancel(run.id))}>
                <Square />
              </button>
            )}
            {['needs_verification', 'conflict'].includes(run.state) && (
              <button
                disabled={
                  !agents.find(
                    (agent) =>
                      agent.id ===
                      (skills.find(
                        (skill) => skill.id === run.skillId && skill.version === run.version,
                      )?.workflow
                        ? 'openadapt'
                        : 'codex'),
                  )?.enabled
                }
                onClick={() => void action(() => api.verify(run.id))}
              >
                <RefreshCw />
                核验实际结果
              </button>
            )}
            {['needs_verification', 'conflict'].includes(run.state) &&
              skills.find((skill) => skill.id === run.skillId && skill.version === run.version)
                ?.workflow && (
                <button onClick={() => setManualRun(run)}>
                  <Check />
                  人工核验
                </button>
              )}
            {details === run.id && (
              <pre>
                {run.log}\n{run.receipt}
              </pre>
            )}
          </div>
        ))}
      </section>
      {form && (
        <div className="or-modal-backdrop">
          <form
            role="dialog"
            aria-modal="true"
            aria-label="确认 Skill"
            className="or-modal"
            onSubmit={(e) => {
              e.preventDefault()
              setSaving(true)
              void api
                .saveSkill({ ...form, workflow: mode === 'openadapt' ? form.workflow : undefined })
                .then(() => {
                  setError('')
                  setForm(null)
                  void load()
                })
                .catch((e) => setError(String(e)))
                .finally(() => setSaving(false))
            }}
          >
            <header>
              <h2>{form.id ? '发布新版本' : '确认 SOP'}</h2>
              <button type="button" title="关闭" onClick={() => setForm(null)}>
                <X />
              </button>
            </header>
            {error && (
              <p className="or-error" role="alert">
                {error}
              </p>
            )}
            <label>
              执行方式
              <select
                aria-label="执行方式"
                value={mode}
                onChange={(event) => setMode(event.target.value as typeof mode)}
              >
                <option value="codex">Codex · 公司文档</option>
                <option value="openadapt">本地流程 · 浏览器操作</option>
                <option disabled>Claude · 暂不可用</option>
              </select>
            </label>
            {mode === 'openadapt' && (
              <>
                <label>
                  关联录制
                  <select
                    required
                    aria-label="关联录制"
                    value={form.workflow?.recordingId || ''}
                    onChange={(event) => {
                      const recording = recordings.find((item) => item.id === event.target.value)
                      if (recording)
                        setForm({
                          ...form,
                          target: recording.url,
                          workflow: {
                            engine: 'openadapt',
                            recordingId: recording.id,
                            digest: recording.digest,
                            parameters: recording.parameters,
                          },
                        })
                    }}
                  >
                    <option value="">请选择已完成的录制</option>
                    {recordings
                      .filter((item) => item.state === 'ready')
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title} · {item.steps} 步
                        </option>
                      ))}
                  </select>
                </label>
                {form.workflow && (
                  <>
                    <label>
                      结果核验接口（可选，只读 JSON 地址）
                      <input
                        type="url"
                        value={form.workflow.verification?.url || ''}
                        onChange={(event) => {
                          const workflow = form.workflow!
                          setForm({
                            ...form,
                            workflow: {
                              ...workflow,
                              verification: event.target.value
                                ? {
                                    url: event.target.value,
                                    checks:
                                      workflow.verification?.checks ||
                                      Object.keys(workflow.parameters).map((parameter) => ({
                                        parameter,
                                        pointer: '/' + parameter,
                                      })),
                                  }
                                : undefined,
                            },
                          })
                        }}
                      />
                    </label>
                    {form.workflow.verification?.checks.map((check, index) => (
                      <label key={check.parameter}>
                        {check.parameter} · 核验 JSON 路径
                        <input
                          required
                          value={check.pointer}
                          onChange={(event) => {
                            const workflow = form.workflow!,
                              verification = workflow.verification!
                            setForm({
                              ...form,
                              workflow: {
                                ...workflow,
                                verification: {
                                  ...verification,
                                  checks: verification.checks.map((item, i) =>
                                    i === index ? { ...item, pointer: event.target.value } : item,
                                  ),
                                },
                              },
                            })
                          }}
                        />
                      </label>
                    ))}
                  </>
                )}
              </>
            )}
            {fields.map(([key, label]) => (
              <label key={key}>
                {fieldLabel(key, label)}
                {key === 'title' || key === 'target' ? (
                  <input
                    aria-label={fieldLabel(key, label)}
                    required
                    type={key === 'target' ? 'url' : 'text'}
                    value={String(form[key] || '')}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  />
                ) : (
                  <textarea
                    aria-label={fieldLabel(key, label)}
                    required
                    rows={2}
                    value={String(form[key] || '')}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  />
                )}
              </label>
            ))}
            <label>
              <input type="checkbox" required />
              确认保存目标、操作范围和规则
            </label>
            <button
              className="or-primary"
              type="submit"
              disabled={saving || (mode === 'openadapt' && !form.workflow)}
            >
              <Save />
              {saving ? '保存中…' : '确认并发布'}
            </button>
          </form>
        </div>
      )}
      {manualRun && (
        <div className="or-modal-backdrop">
          <form
            role="dialog"
            aria-modal="true"
            aria-label="人工核验"
            className="or-modal"
            onSubmit={(event) => {
              event.preventDefault()
              setSaving(true)
              void action(() => api.acknowledgeRun(manualRun.id))
                .then((ok) => {
                  if (ok) setManualRun(null)
                })
                .finally(() => setSaving(false))
            }}
          >
            <header>
              <h2>人工核验</h2>
              <button type="button" title="关闭" onClick={() => setManualRun(null)}>
                <X />
              </button>
            </header>
            <p>{manualRun.target}</p>
            {error && (
              <p className="or-error" role="alert">
                {error}
              </p>
            )}
            <label>
              <input type="checkbox" required />
              我已在目标系统检查本次实际结果，并确认可以结束待核验状态
            </label>
            <button type="submit" className="or-primary" disabled={saving}>
              <Check />
              确认核验完成
            </button>
          </form>
        </div>
      )}
      {runForm && (
        <div className="or-modal-backdrop">
          <form
            role="dialog"
            aria-modal="true"
            aria-label="复用流程"
            className="or-modal"
            onSubmit={(event) => {
              event.preventDefault()
              setSaving(true)
              void action(() =>
                api.run(runForm.skill.id, runForm.skill.version, runForm.parameters),
              )
                .then((ok) => {
                  if (ok) setRunForm(null)
                })
                .finally(() => setSaving(false))
            }}
          >
            <header>
              <h2>
                {runForm.skill.title} · v{runForm.skill.version}
              </h2>
              <button type="button" title="关闭" onClick={() => setRunForm(null)}>
                <X />
              </button>
            </header>
            {error && (
              <p role="alert" className="or-error">
                {error}
              </p>
            )}
            <p>{runForm.skill.target}</p>
            <p>{runForm.skill.scope}</p>
            {Object.entries(runForm.parameters).map(([name, value]) => (
              <label key={name}>
                {name}
                <input
                  required
                  value={value}
                  onChange={(event) =>
                    setRunForm({
                      ...runForm,
                      parameters: { ...runForm.parameters, [name]: event.target.value },
                    })
                  }
                />
              </label>
            ))}
            <label>
              <input required type="checkbox" />
              确认在目标页面执行本次操作
            </label>
            <button type="submit" className="or-primary" disabled={saving}>
              <Play />
              开始执行
            </button>
          </form>
        </div>
      )}
      <section className="or-section">
        <div className="or-header">
          <h2>配券 / 策略规则</h2>
          <button
            onClick={() =>
              setRule({ title: '', steps: '', variables: '', prerequisites: '', approvals: '' })
            }
          >
            <Plus />
            沉淀规则
          </button>
        </div>
        {!rules.length && <p className="or-muted">暂无规则</p>}
        {rules.map((r) => (
          <div className="or-row" key={r.id}>
            <div className="or-row-content">
              <strong>{r.title}</strong>
              <details>
                <summary>查看预览</summary>
                <pre>{`步骤\n${r.steps}\n\n变量\n${r.variables}\n\n前提\n${r.prerequisites}\n\n审批点\n${r.approvals}`}</pre>
              </details>
            </div>
            <button disabled>
              <Play />
              执行
            </button>
          </div>
        ))}
      </section>
      {rule && (
        <div className="or-modal-backdrop">
          <form
            role="dialog"
            aria-modal="true"
            aria-label="策略规则"
            className="or-modal"
            onSubmit={(e) => {
              e.preventDefault()
              setSaving(true)
              void action(() => api.saveRule(rule))
                .then((saved) => {
                  if (saved) setRule(null)
                })
                .finally(() => setSaving(false))
            }}
          >
            <header>
              <h2>配券 / 策略预览</h2>
              <button type="button" title="关闭" onClick={() => setRule(null)}>
                <X />
              </button>
            </header>
            {error && (
              <p className="or-error" role="alert">
                {error}
              </p>
            )}
            {(['title', 'steps', 'variables', 'prerequisites', 'approvals'] as const).map(
              (key, i) => (
                <label key={key}>
                  {['名称', '步骤', '变量', '前提', '审批点'][i]}
                  <textarea
                    aria-label={['名称', '步骤', '变量', '前提', '审批点'][i]}
                    required
                    rows={3}
                    value={rule[key]}
                    onChange={(e) => setRule({ ...rule, [key]: e.target.value })}
                  />
                </label>
              ),
            )}
            <button type="submit" className="or-primary" disabled={saving}>
              <Save />
              保存规则
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
