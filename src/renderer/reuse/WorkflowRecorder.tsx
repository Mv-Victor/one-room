import { useState } from 'react'
import { Circle, Square, X } from 'lucide-react'
import type { ReuseAPI } from '../../services/reuse/types'
import type { WorkflowRecording } from '../../services/reuse/workflow-types'

const labels: Record<WorkflowRecording['state'], string> = {
  starting: '正在打开浏览器',
  browser_ready: '等待开始 · 登录操作不录制',
  recording: '录制中',
  compiling: '正在生成流程',
  ready: '可复用',
  failed: '未完成',
}
export function WorkflowRecorder({
  api,
  recordings,
  refresh,
  onError,
}: {
  api: ReuseAPI
  recordings: WorkflowRecording[]
  refresh(): Promise<void>
  onError(message: string): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false)
  const [title, setTitle] = useState(''),
    [url, setURL] = useState('')
  const [parameters, setParameters] = useState(''),
    [secrets, setSecrets] = useState('')
  const active = recordings.some((item) =>
    ['starting', 'browser_ready', 'recording', 'compiling'].includes(item.state),
  )
  const fields = (value: string): string[] =>
    value
      .split(/[,，、\n]/)
      .map((item) => item.trim())
      .filter(Boolean)
  return (
    <section className="or-section">
      <div className="or-header">
        <h2>流程录制</h2>
        <button disabled={active} onClick={() => setOpen(!open)}>
          <Circle />
          新建录制
        </button>
      </div>
      {open && (
        <form
          className="or-record-form"
          onSubmit={(event) => {
            event.preventDefault()
            setBusy(true)
            void api
              .recordWorkflow({
                title,
                url,
                parameterFields: fields(parameters),
                secretFields: fields(secrets),
              })
              .then(async () => {
                setOpen(false)
                onError('')
                await refresh()
              })
              .catch((error) => onError(String(error)))
              .finally(() => setBusy(false))
          }}
        >
          <label>
            流程名称
            <input required value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            起始页面地址
            <input
              required
              type="url"
              value={url}
              onChange={(event) => setURL(event.target.value)}
            />
          </label>
          <label>
            可变字段名称（表单 name / id，逗号分隔）
            <input value={parameters} onChange={(event) => setParameters(event.target.value)} />
          </label>
          <label>
            敏感字段名称（逗号分隔）
            <input value={secrets} onChange={(event) => setSecrets(event.target.value)} />
          </label>
          <label className="or-consent">
            <input required type="checkbox" />
            允许在新开的浏览器窗口记录本次点击、表单内容和页面截图
          </label>
          <div className="or-actions">
            <button type="submit" className="or-primary" disabled={busy}>
              <Circle />
              开始录制
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              <X />
              取消
            </button>
          </div>
        </form>
      )}
      {!recordings.length && <p className="or-muted">暂无录制</p>}
      {recordings.map((item) => (
        <div className="or-row" key={item.id}>
          <div className="or-row-content">
            <strong>{item.title}</strong>
            <p>
              {labels[item.state]} · {item.steps} 个步骤
            </p>
            <p>{item.url}</p>
            {item.error && <p className="or-error">{item.error}</p>}
          </div>
          {item.state === 'browser_ready' && (
            <button
              className="or-primary"
              onClick={() => {
                void api
                  .beginRecording(item.id)
                  .then(refresh)
                  .catch((error) => onError(String(error)))
              }}
            >
              <Circle />
              开始记录操作
            </button>
          )}
          {['starting', 'browser_ready', 'recording'].includes(item.state) && (
            <button
              title="结束并生成流程"
              onClick={() => {
                void api
                  .stopRecording(item.id)
                  .then(refresh)
                  .catch((error) => onError(String(error)))
              }}
            >
              <Square />
              结束录制
            </button>
          )}
        </div>
      ))}
    </section>
  )
}
