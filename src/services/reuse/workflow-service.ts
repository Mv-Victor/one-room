import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type { WorkflowRecording, WorkflowRecordingInput, WorkflowBinding } from './workflow-types'

export function workflowURL(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('目标需要不含账号密码的 HTTP / HTTPS 地址')
  return url.href
}

/** Hash every asset, not just workflow.json: recorded anchors are execution authority. */
export function bundleDigest(directory: string): string {
  const hash = createHash('sha256')
  let bytes = 0
  const visit = (relative: string): void => {
    const full = path.join(directory, relative)
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) throw new Error('工作流不能包含符号链接')
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name))
    } else if (stat.isFile()) {
      bytes += stat.size
      if (bytes > 300 * 1024 * 1024) throw new Error('工作流超过 300 MB')
      hash.update(relative).update('\0').update(fs.readFileSync(full)).update('\0')
    } else throw new Error('不支持的工作流文件')
  }
  visit('')
  return hash.digest('hex')
}

export class WorkflowService {
  private children = new Map<string, ChildProcess>()
  private pending = new Set<Promise<unknown>>()
  private runLock: string | null = null
  constructor(
    readonly root: string,
    readonly runtime: string,
    readonly bridge: string,
  ) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    for (const recording of this.list()) {
      if (['starting', 'browser_ready', 'recording', 'compiling'].includes(recording.state))
        this.write({ ...recording, state: 'failed', error: '应用重启，录制未完成；请重新录制' })
    }
  }
  get python(): string {
    return path.join(this.runtime, 'python/bin/python3')
  }
  get environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONHOME: path.join(this.runtime, 'python'),
      PYTHONPATH: path.join(this.runtime, 'site-packages'),
      PYTHONUNBUFFERED: '1',
      PLAYWRIGHT_BROWSERS_PATH: path.join(this.runtime, 'browsers'),
    }
    // Managed workflows cannot silently acquire a paid/off-box grounding capability.
    for (const name of Object.keys(env))
      if (/^(OPENADAPT_|ANTHROPIC_API_KEY|OPENAI_API_KEY)/.test(name)) delete env[name]
    return env
  }
  available(): boolean {
    return (
      fs.existsSync(this.python) &&
      fs.existsSync(this.bridge) &&
      fs.existsSync(path.join(this.runtime, 'site-packages/openadapt_flow/__init__.py')) &&
      fs.existsSync(path.join(this.runtime, 'browsers'))
    )
  }
  directory(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效录制编号')
    return path.join(this.root, id)
  }
  list(): WorkflowRecording[] {
    return fs
      .readdirSync(this.root)
      .filter((id) => /^[a-f0-9-]{36}$/.test(id))
      .flatMap((id) => {
        try {
          return [
            JSON.parse(
              fs.readFileSync(path.join(this.directory(id), 'manifest.json'), 'utf8'),
            ) as WorkflowRecording,
          ]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }
  private write(recording: WorkflowRecording): void {
    const file = path.join(this.directory(recording.id), 'manifest.json')
    fs.writeFileSync(file + '.tmp', JSON.stringify(recording), { mode: 0o600 })
    fs.renameSync(file + '.tmp', file)
  }
  start(input: WorkflowRecordingInput): WorkflowRecording {
    if (!this.available()) throw new Error('本地流程引擎未打包，请运行构建脚本准备运行时')
    if (this.children.size || this.runLock) throw new Error('请先结束当前录制或流程执行')
    const recording: WorkflowRecording = {
      ...input,
      url: workflowURL(input.url),
      id: randomUUID(),
      createdAt: Date.now(),
      state: 'starting',
      digest: '',
      parameters: {},
      steps: 0,
      error: '',
    }
    const directory = this.directory(recording.id)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.write(recording)
    const config = path.join(directory, 'config.json')
    fs.writeFileSync(config, JSON.stringify({ ...recording, root: directory }), { mode: 0o600 })
    const child = spawn(this.python, [this.bridge, config], {
      cwd: directory,
      env: this.environment,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.children.set(recording.id, child)
    const trace = fs.createWriteStream(path.join(directory, 'recording.log'), { mode: 0o600 })
    let buffer = '',
      diagnostics = '',
      ready = false
    const consume = (line: string): void => {
      try {
        const event = JSON.parse(line)
        if (['browser_ready', 'recording', 'compiling'].includes(event.event))
          recording.state = event.event
        if (event.event === 'ready') {
          recording.digest = bundleDigest(path.join(directory, 'bundle'))
          recording.parameters = event.parameters
          recording.steps = event.steps
          recording.state = 'compiling'
          ready = true
        }
        if (event.event === 'failed') {
          recording.state = 'failed'
          recording.error = /more than one logical browser action/.test(event.error)
            ? '操作间隔过短，未能保留每步画面；请重新录制并稍作停顿'
            : /viewport|geometry/.test(event.error)
              ? '录制窗口发生变化，请保持浏览器尺寸不变后重新录制'
              : /[\u4e00-\u9fff]/.test(event.error)
                ? event.error
                : '录制未完成，详细原因已保存到本地录制日志'
        }
        this.write(recording)
      } catch {
        /* upstream diagnostics are not lifecycle events */
      }
    }
    child.stdout?.on('data', (data) => {
      trace.write(data)
      buffer += data.toString()
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
    })
    child.stderr?.on('data', (data) => {
      trace.write(data)
      diagnostics = (diagnostics + data.toString()).slice(-4000)
    })
    const done = new Promise<void>((resolve) => {
      child.once('error', (error) => {
        recording.error = `无法启动本地流程引擎：${error.message}`
      })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        trace.end()
        if (buffer) consume(buffer)
        this.children.delete(recording.id)
        if (!ready || code !== 0) {
          recording.state = 'failed'
          recording.error ||= `录制未完成：${diagnostics || signal || code}`
        } else recording.state = 'ready'
        this.write(recording)
        resolve()
      })
    })
    const timer = setTimeout(
      () => {
        recording.error = '录制超过 30 分钟，已停止'
        try {
          process.kill(-child.pid!, 'SIGTERM')
        } catch {
          /* exited */
        }
      },
      30 * 60 * 1000,
    )
    timer.unref()
    this.pending.add(done)
    void done.finally(() => this.pending.delete(done))
    return { ...recording }
  }
  finish(id: string): void {
    if (!this.children.has(id)) throw new Error('该录制已结束')
    fs.writeFileSync(path.join(this.directory(id), 'stop'), '', { mode: 0o600 })
  }
  begin(id: string): void {
    if (
      !this.children.has(id) ||
      this.list().find((item) => item.id === id)?.state !== 'browser_ready'
    )
      throw new Error('浏览器尚未就绪，或录制已经开始')
    fs.writeFileSync(path.join(this.directory(id), 'arm'), '', { mode: 0o600 })
  }
  acquireRun(id: string): void {
    if (this.children.size || this.runLock) throw new Error('请先结束当前录制或流程执行')
    this.runLock = id
  }
  releaseRun(id: string): void {
    if (this.runLock === id) this.runLock = null
  }
  validate(binding: WorkflowBinding, target: string): WorkflowRecording {
    const recording = this.list().find((item) => item.id === binding.recordingId)
    if (!recording || recording.state !== 'ready') throw new Error('请选择一份已完成的录制')
    if (workflowURL(target) !== recording.url) throw new Error('目标必须与录制起始页面一致')
    if (
      binding.digest !== recording.digest ||
      bundleDigest(path.join(this.directory(recording.id), 'bundle')) !== binding.digest
    )
      throw new Error('工作流已变化，请重新录制并发布新版本')
    for (const name of Object.keys(binding.parameters))
      if (!Object.hasOwn(recording.parameters, name)) throw new Error(`未知参数：${name}`)
    if (binding.verification) {
      if (new URL(workflowURL(binding.verification.url)).origin !== new URL(target).origin)
        throw new Error('核验接口必须与目标页面同源')
      if (!binding.verification.checks.length) throw new Error('需要至少一条实际结果核验条件')
      for (const check of binding.verification.checks)
        if (!check.pointer.startsWith('/') || !Object.hasOwn(recording.parameters, check.parameter))
          throw new Error('核验字段或参数无效')
    }
    return recording
  }
  async stop(): Promise<void> {
    for (const child of this.children.values()) {
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {
        /* exited */
      }
    }
    await Promise.allSettled(this.pending)
  }
}
