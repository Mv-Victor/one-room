import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexExecutor } from './agent-executor'
import type { AgentRun, SkillVersion } from './types'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn() }))
vi.mock('node:child_process', async (original) => {
  const { promisify } = await import('node:util')
  return {
    ...(await original<typeof import('node:child_process')>()),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }),
    spawn: mocks.spawn,
  }
})

const skill: SkillVersion = {
  id: 'skill',
  version: 1,
  createdAt: 0,
  title: '日报',
  purpose: '日报更新',
  target: 'https://docs.corp.kuaishou.com/d/home/test-document',
  scope: '今天',
  format: 'JsonML',
  variables: '日期',
  sources: '指定文档',
  dedup: '日期',
  success: '回读正确',
}
const run: AgentRun = {
  id: 'run',
  skillId: 'skill',
  version: 1,
  target: skill.target,
  state: 'queued',
  createdAt: 0,
  updatedAt: 0,
  log: '',
  receipt: '',
  error: '',
}
const readCommand =
  'node docs-shared-capture.js --command-kind word.fetch-jsonml -- kcli docs-cli word +fetch-jsonml --doc-id test-document'
const writeCommand =
  'kcli docs-cli word +update-jsonml --doc-id test-document --file-path /tmp/patch.json'
let root: string, executor: CodexExecutor, traces: fs.WriteStream[]
let child: EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  kill: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  mocks.exec.mockReset()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-room-agent-'))
  executor = new CodexExecutor(root)
  child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42424242,
    kill: vi.fn(),
  })
  mocks.spawn.mockReturnValue(child)
  vi.spyOn(process, 'kill').mockReturnValue(true)
  traces = []
  const create = fs.createWriteStream
  vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
    const trace = create(...args)
    traces.push(trace)
    return trace
  })
})
afterEach(async () => {
  await Promise.all(
    traces.map((trace) => (trace.closed ? Promise.resolve() : once(trace, 'close'))),
  )
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})
function event(command: string, output: unknown, exitCode = 0): void {
  child.stdout.write(
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command,
        exit_code: exitCode,
        aggregated_output: JSON.stringify(output),
      },
    }) + '\n',
  )
}
function read(body: unknown = { ok: true, data: { content: ['div', {}, '正文'] } }): void {
  const stdoutPath = path.join(root, 'document.json')
  fs.writeFileSync(stdoutPath, JSON.stringify(body))
  event(readCommand, {
    ok: true,
    capture: { commandKind: 'word.fetch-jsonml', exitCode: 0, stdoutPath },
  })
}
function finish(status = 'succeeded', verify = false): void {
  fs.writeFileSync(
    path.join(root, run.id, verify ? 'verification.json' : 'result.json'),
    JSON.stringify({
      status,
      checks: ['格式和目标范围已核验'],
      summary: status,
    }),
  )
  child.emit('close', 0)
}

describe.skipIf(process.platform !== 'darwin')('Finder CLI discovery', () => {
  it('keeps inherited CLI paths when a slow login shell times out', async () => {
    mocks.exec
      .mockRejectedValueOnce(new Error('Login shell timed out'))
      .mockResolvedValueOnce({ stdout: 'codex-cli test', stderr: '' })
      .mockResolvedValueOnce({ stdout: '--json --output-schema --ephemeral', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: 'Logged in using ChatGPT' })
      .mockResolvedValueOnce({ stdout: 'docs-cli test', stderr: '' })
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    expect((await executor.detect())[0]).toMatchObject({ enabled: true })
    const options = mocks.exec.mock.calls[1][2]
    const paths = options.env.PATH.split(path.delimiter)
    for (const entry of (process.env.PATH || '').split(path.delimiter).filter(Boolean))
      expect(paths).toContain(entry)
    expect(paths).toContain(path.join(os.homedir(), '.local/bin'))
    expect(paths).toContain('/opt/homebrew/bin')
  })
  it('uses the resolved NVM and inherited paths for the actual execution process', async () => {
    mocks.exec
      .mockResolvedValueOnce({ stdout: '/nvm/active/bin:/usr/bin\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'codex-cli test', stderr: '' })
      .mockResolvedValueOnce({ stdout: '--json --output-schema --ephemeral', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'docs-cli test', stderr: '' })
    const exists = fs.existsSync
    vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
      String(p).endsWith('.codex/skills/docs-cli/SKILL.md') ? true : exists(p),
    )
    expect((await executor.detect())[0].enabled).toBe(true)
    const result = executor.execute(skill, run, false, vi.fn())
    expect(mocks.spawn.mock.lastCall![2].env.PATH.split(path.delimiter)).toContain(
      '/nvm/active/bin',
    )
    expect(mocks.spawn.mock.lastCall![2].env.PATH.split(path.delimiter)).toContain(
      '/opt/homebrew/bin',
    )
    child.emit('close', 0)
    await result
  })
})

describe('Codex execution evidence and interruption', () => {
  it('does not report success when the CLI exits with an error after writing', async () => {
    const result = executor.execute(skill, run, false, vi.fn())
    read()
    event(writeCommand, { ok: true })
    read()
    fs.writeFileSync(
      path.join(root, run.id, 'result.json'),
      JSON.stringify({ status: 'succeeded', checks: ['ok'] }),
    )
    child.emit('close', 1)
    expect((await result).state).toBe('needs_verification')
  })
  it('rejects a success claim without real tool receipts', async () => {
    const result = executor.execute(skill, run, false, vi.fn())
    finish()
    expect((await result).state).toBe('failed')
  })
  it('requires a successful initial read, write receipt and actual read-back response', async () => {
    const result = executor.execute(skill, run, false, vi.fn())
    read()
    event(writeCommand, { ok: true, data: { version: 2 } })
    read()
    finish()
    expect((await result).state).toBe('succeeded')
    expect(fs.existsSync(path.join(root, run.id, 'read-2.json'))).toBe(true)
  })
  it('does not accept a successful wrapper around a failed document response', async () => {
    const result = executor.execute(skill, run, false, vi.fn())
    read()
    event(writeCommand, { ok: true })
    read({ ok: false, error: { message: 'Permission denied' } })
    finish()
    expect((await result).state).toBe('needs_verification')
  })
  it('cannot verify from a missing capture body', async () => {
    const result = executor.execute(skill, run, false, vi.fn())
    read()
    event(writeCommand, { ok: true })
    event(readCommand, {
      ok: true,
      capture: {
        commandKind: 'word.fetch-jsonml',
        exitCode: 0,
        stdoutPath: path.join(root, 'missing.raw'),
      },
    })
    finish()
    expect((await result).state).toBe('needs_verification')
  })
  it('keeps a write without a receipt uncertain even if the agent claims success', async () => {
    const result = executor.execute(skill, run, false, vi.fn())
    read()
    event(writeCommand, { ok: false, error: { message: 'Timed out' } }, 1)
    read()
    finish()
    expect((await result).state).toBe('needs_verification')
  })
  it('requires reading the current document before writing', async () => {
    const result = executor.execute(skill, run, false, vi.fn())
    event(writeCommand, { ok: true })
    read()
    finish()
    expect((await result).state).toBe('needs_verification')
  })
  it('reports pre-write process-group cancellation accurately', async () => {
    const result = executor.execute(skill, run, false, vi.fn())
    executor.cancel(run.id)
    child.emit('close', null)
    expect((await result).state).toBe('canceled')
    if (process.platform !== 'win32')
      expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
  })
  it('keeps cancellation after a write attempt pending verification', async () => {
    const result = executor.execute(skill, run, false, vi.fn())
    read()
    event(writeCommand, { ok: true })
    executor.cancel(run.id)
    child.emit('close', null)
    expect((await result).state).toBe('needs_verification')
  })
  it('accepts no-change only after an actual read', async () => {
    const result = executor.execute(skill, run, false, vi.fn())
    read()
    finish('no_change')
    expect((await result).state).toBe('no_change')
  })
  it('verifies an earlier write with a read-only run', async () => {
    const result = executor.execute(
      skill,
      { ...run, receipt: JSON.stringify({ writeSucceeded: true }) },
      true,
      vi.fn(),
    )
    read()
    finish('succeeded', true)
    expect((await result).state).toBe('succeeded')
  })
  it('recovers a durable write receipt from the trace after an app crash', async () => {
    fs.mkdirSync(path.join(root, run.id))
    fs.writeFileSync(
      path.join(root, run.id, 'trace.jsonl'),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: writeCommand,
          exit_code: 0,
          aggregated_output: JSON.stringify({ ok: true, data: { version: 2 } }),
        },
      }) + '\n{"type":"partial',
    )
    const result = executor.execute(skill, run, true, vi.fn())
    read()
    finish('succeeded', true)
    const verified = await result
    expect(verified.state).toBe('succeeded')
    expect(verified.receipt).toContain('prior-trace')
  })
  it('handles an early child stdin failure without crashing the host', async () => {
    const result = executor.execute(skill, run, false, vi.fn())
    child.stdin.emit('error', new Error('write EPIPE'))
    child.emit('close', 1)
    expect(await result).toMatchObject({ state: 'failed', error: 'write EPIPE' })
  })
})
