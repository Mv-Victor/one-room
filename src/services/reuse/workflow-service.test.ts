import { afterEach, describe, expect, it, vi } from 'vitest'
import * as childProcess from 'node:child_process'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { bundleDigest, WorkflowService, workflowURL } from './workflow-service'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const directories: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-room-workflow-unit-'))
  directories.push(root)
  const service = new WorkflowService(root, '/missing', '/missing')
  const id = randomUUID(),
    directory = path.join(root, id)
  fs.mkdirSync(path.join(directory, 'bundle'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'bundle/workflow.json'), '{}')
  const recording = {
    id,
    state: 'ready',
    title: '测试',
    url: 'http://127.0.0.1:1234/',
    createdAt: 1,
    steps: 2,
    parameters: { title: '旧值' },
    digest: bundleDigest(path.join(directory, 'bundle')),
  }
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(recording))
  return { service, recording, directory }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})
describe('本地流程权限和不可变版本', () => {
  it('录制进程退出前不发布就绪状态，避免立即复用撞上浏览器锁', async () => {
    const { service } = fixture()
    const child = Object.assign(new childProcess.ChildProcess(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    vi.mocked(childProcess.spawn).mockReturnValue(child)
    vi.spyOn(service, 'available').mockReturnValue(true)
    const recording = service.start({
      title: '测试录制',
      url: 'http://127.0.0.1:1234/',
      parameterFields: [],
      secretFields: [],
    })
    const directory = path.join(service.directory(recording.id), 'bundle')
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'workflow.json'), '{}')
    child.stdout.write(JSON.stringify({ event: 'ready', parameters: {}, steps: 1 }) + '\n')
    await vi.waitFor(() =>
      expect(
        fs.readFileSync(path.join(service.directory(recording.id), 'recording.log'), 'utf8'),
      ).toContain('"event":"ready"'),
    )
    expect(service.list().find((item) => item.id === recording.id)?.state).toBe('compiling')
    expect(() => service.acquireRun('run')).toThrow('请先结束')
    child.emit('close', 0, null)
    expect(service.list().find((item) => item.id === recording.id)?.state).toBe('ready')
    expect(() => service.acquireRun('run')).not.toThrow()
    service.releaseRun('run')
    await service.stop()
  })
  it('拒绝任意协议、内嵌账号和目录越界', () => {
    const { service } = fixture()
    expect(() => workflowURL('file:///etc/passwd')).toThrow()
    expect(() => workflowURL('https://user:secret@example.com')).toThrow()
    expect(() => service.directory('../outside')).toThrow()
  })
  it('检查每份执行素材的摘要、录制目标和参数', () => {
    const { service, recording, directory } = fixture()
    const binding = {
      engine: 'openadapt' as const,
      recordingId: recording.id,
      digest: recording.digest,
      parameters: { title: '新值' },
    }
    expect(service.validate(binding, recording.url).id).toBe(recording.id)
    expect(() => service.validate(binding, 'http://127.0.0.1:1234/other')).toThrow()
    expect(() =>
      service.validate({ ...binding, parameters: { unknown: '值' } }, recording.url),
    ).toThrow()
    fs.writeFileSync(path.join(directory, 'bundle/anchor.png'), 'changed')
    expect(() => service.validate(binding, recording.url)).toThrow('工作流已变化')
  })
  it('核验只能使用同源只读接口，不能把参数发送到第三方', () => {
    const { service, recording } = fixture()
    const binding = {
      engine: 'openadapt' as const,
      recordingId: recording.id,
      digest: recording.digest,
      parameters: { title: '新值' },
      verification: {
        url: 'https://unrelated.example/read',
        checks: [{ pointer: '/title', parameter: 'title' }],
      },
    }
    expect(() => service.validate(binding, recording.url)).toThrow('同源')
    binding.verification.url = recording.url
    expect(service.validate(binding, recording.url)).toBeTruthy()
    binding.verification.checks[0].parameter = 'not-present'
    expect(() => service.validate(binding, recording.url)).toThrow('核验字段或参数无效')
  })
  it('重启不自动续录或重放，未打包时不报告已安装', () => {
    const { service, recording, directory } = fixture()
    fs.writeFileSync(
      path.join(directory, 'manifest.json'),
      JSON.stringify({ ...recording, state: 'recording' }),
    )
    const restarted = new WorkflowService(service.root, '/missing', '/missing')
    expect(restarted.list()[0].state).toBe('failed')
    expect(restarted.available()).toBe(false)
    expect(() =>
      restarted.start({ title: '测试', url: recording.url, parameterFields: [], secretFields: [] }),
    ).toThrow()
  })
})
