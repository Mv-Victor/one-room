import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { AgentExecutor } from './agent-executor'
import type { AgentRun, AgentStatus, RunState, SkillInput, SkillVersion } from './types'
import type { WorkflowBinding } from './workflow-types'
import { WorkflowService } from './workflow-service'

function pointerValue(body: unknown, pointer: string): unknown {
  return pointer
    .slice(1)
    .split('/')
    .reduce<unknown>((value, key) => {
      const name = key.replace(/~1/g, '/').replace(/~0/g, '~')
      return value !== null && typeof value === 'object' && Object.hasOwn(value, name)
        ? (value as Record<string, unknown>)[name]
        : undefined
    }, body)
}
export async function readWorkflowResult(
  binding: WorkflowBinding,
  parameters: Record<string, string>,
): Promise<{ body: unknown; matches: boolean }> {
  if (!binding.verification) throw new Error('该流程未配置独立核验接口，需人工检查实际结果')
  const response = await fetch(binding.verification.url, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`核验接口返回 ${response.status}`)
  let text = ''
  if (!response.body) throw new Error('核验接口无响应正文')
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  try {
    let part = await reader.read()
    while (!part.done) {
      text += decoder.decode(part.value, { stream: true })
      if (text.length > 1024 * 1024) {
        await reader.cancel()
        throw new Error('核验响应超过 1 MB')
      }
      part = await reader.read()
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  const body: unknown = JSON.parse(text)
  return {
    body,
    matches: binding.verification.checks.every(
      (check) => pointerValue(body, check.pointer) === parameters[check.parameter],
    ),
  }
}

/** Dispatch frozen SOPs to a local recorder/replayer or the existing Docs agent. */
export class WorkflowExecutor implements AgentExecutor {
  private children = new Map<string, ChildProcess>()
  private canceled = new Set<string>()
  private verifications = new Set<string>()
  constructor(
    readonly workflows: WorkflowService,
    private docs: AgentExecutor,
  ) {}
  validateSkill(input: SkillInput): void {
    if (input.workflow) this.workflows.validate(input.workflow, input.target)
  }
  async detect(): Promise<AgentStatus[]> {
    const enabled = this.workflows.available()
    return [
      {
        id: 'openadapt',
        installed: enabled,
        authenticated: enabled,
        enabled,
        detail: enabled ? '本地流程引擎就绪 · 无需模型登录' : '本地流程引擎未打包',
      },
      ...(await this.docs.detect()),
    ]
  }
  cancel(id: string): void {
    this.docs.cancel(id)
    if (this.verifications.has(id) || this.children.has(id)) this.canceled.add(id)
    const child = this.children.get(id)
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* exited */
      }
      const timer = setTimeout(() => {
        if (this.children.get(id) !== child) return
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          /* exited */
        }
      }, 3000)
      timer.unref()
      child.once('close', () => clearTimeout(timer))
    }
  }
  async execute(
    skill: SkillVersion,
    run: AgentRun,
    verifyOnly: boolean,
    onEvent: (state: RunState, line: string) => void,
  ): Promise<{ state: RunState; receipt: string; error: string }> {
    if (!skill.workflow) return this.docs.execute(skill, run, verifyOnly, onEvent)
    const binding = skill.workflow
    this.workflows.validate(binding, skill.target)
    const directory = path.join(this.workflows.root, 'runs', run.id)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const request = path.join(directory, 'request.json')
    let parameters: Record<string, string>, before: unknown
    let acted = verifyOnly
    this.verifications.add(run.id)
    try {
      this.workflows.acquireRun(run.id)
      if (verifyOnly) {
        const prior = JSON.parse(fs.readFileSync(request, 'utf8'))
        if (prior.digest !== binding.digest) throw new Error('运行记录与当前流程不一致')
        parameters = prior.parameters
        before = prior.before
      } else {
        if (
          this.children.size ||
          this.workflows
            .list()
            .some((item) =>
              ['starting', 'browser_ready', 'recording', 'compiling'].includes(item.state),
            )
        )
          throw new Error('请先结束当前的流程录制或执行')
        const supplied = JSON.parse(run.receipt || '{}').parameters || {}
        parameters = { ...binding.parameters, ...supplied }
        this.workflows.validate({ ...binding, parameters }, skill.target)
        onEvent('reading', '读取流程版本和目标状态')
        if (binding.verification) {
          const initial = await readWorkflowResult(binding, parameters)
          before = initial.body
          if (this.canceled.has(run.id)) throw new Error('已取消')
          if (initial.matches)
            return {
              state: 'no_change',
              receipt: JSON.stringify({ parameters, before }),
              error: '',
            }
        }
        if (this.canceled.has(run.id)) throw new Error('已取消')
        fs.writeFileSync(request, JSON.stringify({ digest: binding.digest, parameters, before }), {
          mode: 0o600,
        })
        const paramsFile = path.join(directory, 'parameters.json')
        fs.writeFileSync(paramsFile, JSON.stringify(parameters), { mode: 0o600 })
        onEvent('applying', '在本机浏览器执行已确认的录制步骤')
        acted = true
        const outcome = await this.replay(
          run.id,
          [
            path.join(this.workflows.runtime, 'workflow_replay.py'),
            path.join(this.workflows.root, 'browser-profile'),
            skill.target,
            'replay',
            path.join(this.workflows.directory(binding.recordingId), 'bundle'),
            '--url',
            skill.target,
            '--run-dir',
            directory,
            '--params-file',
            paramsFile,
            '--headed',
            '--backend',
            'web',
          ],
          directory,
        )
        if (outcome.code !== 0 || this.canceled.has(run.id))
          throw new Error(
            this.canceled.has(run.id)
              ? '执行已停止，可能已有操作生效，请核验实际结果'
              : `流程中断，未自动重试。${outcome.error}`,
          )
        const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'))
        if (report.success !== true) throw new Error('执行引擎未完成全部步骤，请核验实际结果')
      }
      onEvent('verifying', '通过只读接口核验实际结果')
      const after = await readWorkflowResult(binding, parameters)
      const verified =
        after.matches &&
        JSON.stringify(before) !== JSON.stringify(after.body) &&
        !this.canceled.has(run.id)
      const receipt = JSON.stringify({
        engine: 'openadapt-flow',
        digest: binding.digest,
        parameters,
        before,
        after: after.body,
        checks: binding.verification?.checks,
        verified,
        directory,
      })
      fs.writeFileSync(path.join(directory, 'one-room-receipt.json'), receipt, { mode: 0o600 })
      return {
        state: verified ? 'succeeded' : 'needs_verification',
        receipt,
        error: verified ? '' : '未能证明实际结果符合全部核验条件，未自动重试',
      }
    } catch (error) {
      return {
        state: acted ? 'needs_verification' : this.canceled.has(run.id) ? 'canceled' : 'failed',
        receipt: JSON.stringify({ directory, engine: 'openadapt-flow', verified: false }),
        error: `流程${acted ? '结果待核验' : '未执行'}：${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      this.workflows.releaseRun(run.id)
      this.verifications.delete(run.id)
      this.canceled.delete(run.id)
    }
  }
  private replay(
    id: string,
    args: string[],
    cwd: string,
  ): Promise<{ code: number | null; error: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.workflows.python, args, {
        cwd,
        env: this.workflows.environment,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.children.set(id, child)
      let diagnostics = ''
      const trace = fs.createWriteStream(path.join(cwd, 'engine.log'), { mode: 0o600 })
      child.stdout?.on('data', (data) => trace.write(data))
      child.stderr?.on('data', (data) => {
        trace.write(data)
        diagnostics = (diagnostics + data.toString()).slice(-2000)
      })
      const timer = setTimeout(
        () => {
          diagnostics = '执行超时'
          this.cancel(id)
        },
        10 * 60 * 1000,
      )
      timer.unref()
      child.once('error', (error) => {
        diagnostics = error.message
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        this.children.delete(id)
        trace.end()
        resolve({ code, error: diagnostics })
      })
    })
  }
}
