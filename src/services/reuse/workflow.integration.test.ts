import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { WorkflowService } from './workflow-service'
import { WorkflowExecutor } from './workflow-executor'
import type { AgentRun, SkillVersion } from './types'

async function until<T>(read: () => T | Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 150000
  while (Date.now() < deadline) {
    const value = await read()
    if (matches(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('等待流程状态超时')
}

it.skipIf(process.env.ONE_ROOM_WORKFLOW_INTEGRATION !== '1')(
  '真实录制、编译、参数化执行、独立回读及只读核验',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-room-flow-live-'))
    const runtime = process.env.ONE_ROOM_WORKFLOW_RUNTIME || path.resolve('build/openadapt')
    const workflows = new WorkflowService(root, runtime, path.join(runtime, 'workflow_bridge.py'))
    const executor = new WorkflowExecutor(workflows, {
      detect: async () => [],
      cancel: () => {},
      execute: async () => {
        throw new Error('不应调用 Codex')
      },
    })
    let stored = { title: 'Empty', owner: 'Nobody', revision: 0 },
      posts = 0,
      browser: { close(): Promise<void> } | undefined,
      rejectWrites = false
    const server = http.createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      if (request.url === '/api/record' && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(stored))
        return
      }
      if (request.url === '/api/record' && request.method === 'POST') {
        let text = ''
        for await (const chunk of request) text += chunk.toString()
        const body = JSON.parse(text)
        posts++
        if (rejectWrites) {
          response.statusCode = 409
          response.end('{}')
          return
        }
        stored = { title: body.title, owner: body.owner, revision: stored.revision + 1 }
        fs.writeFileSync(path.join(root, 'actual-system-record.json'), JSON.stringify(stored))
        response.end(JSON.stringify(stored))
        return
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(
        `<!doctype html><html><head><title>One Room local form</title><style>body{font:20px Arial;margin:80px;background:white;color:#222}label{display:block;margin:20px 0}input,button{font:20px Arial;padding:12px}h1{font-size:28px}</style></head><body><h1>Task assignment</h1><form><label>Title <input id="title" name="title"></label><label>Owner <input id="owner" name="owner"></label><button type="submit">Save</button></form><p id="status">Ready</p><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch('/api/record',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:document.querySelector('#title').value,owner:document.querySelector('#owner').value})});document.querySelector('#status').textContent='Saved'}</script></body></html>`,
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number },
      url = `http://127.0.0.1:${address.port}/`
    try {
      const recording = workflows.start({
        title: 'Local task assignment',
        url,
        parameterFields: ['title', 'owner'],
        secretFields: [],
      })
      await until(
        () => workflows.list()[0],
        (item) => {
          if (item.state === 'failed') throw new Error(item.error)
          return item.state === 'browser_ready'
        },
      )
      const module = process.env.ONE_ROOM_PLAYWRIGHT_MODULE!
      const { chromium } = await import(module)
      const port = fs
        .readFileSync(path.join(root, 'browser-profile/DevToolsActivePort'), 'utf8')
        .split('\n')[0]
      const connected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      browser = connected
      const page = connected.contexts()[0].pages()[0]
      workflows.begin(recording.id)
      await until(
        () => workflows.list()[0],
        (item) => {
          if (item.state === 'failed') throw new Error(item.error)
          return item.state === 'recording'
        },
      )
      const pause = () => page.waitForTimeout(700)
      await page.getByLabel('Title', { exact: true }).click()
      await pause()
      await page.getByLabel('Title', { exact: true }).fill('Recorded task')
      await pause()
      await page.keyboard.press('Tab')
      await pause()
      await page.getByLabel('Owner', { exact: true }).click()
      await pause()
      await page.getByLabel('Owner', { exact: true }).fill('Alice')
      await pause()
      await page.keyboard.press('Tab')
      await pause()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await pause()
      await page.getByText('Saved', { exact: true }).waitFor()
      workflows.finish(recording.id)
      const ready = await until(
        () => workflows.list()[0],
        (item) => {
          if (item.state === 'failed') throw new Error(item.error)
          return item.state === 'ready'
        },
      )
      expect(ready.parameters).toMatchObject({ title: 'Recorded task', owner: 'Alice' })
      expect(ready.steps).toBeGreaterThan(2)
      const skill: SkillVersion = {
        id: randomUUID(),
        version: 1,
        createdAt: Date.now(),
        title: '工单分配',
        purpose: '分配工单',
        target: url,
        scope: '仅本地验收页面',
        format: '录制流程',
        variables: 'title、owner',
        sources: '隔离页面',
        dedup: '不自动重试',
        success: '独立回读匹配',
        workflow: {
          engine: 'openadapt',
          recordingId: ready.id,
          digest: ready.digest,
          parameters: ready.parameters,
          verification: {
            url: url + 'api/record',
            checks: [
              { pointer: '/title', parameter: 'title' },
              { pointer: '/owner', parameter: 'owner' },
            ],
          },
        },
      }
      const run: AgentRun = {
        id: randomUUID(),
        skillId: skill.id,
        version: 1,
        target: url,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state: 'queued',
        log: '',
        error: '',
        receipt: JSON.stringify({ parameters: { title: '中文复用工单', owner: '张三' } }),
      }
      const result = await executor.execute(skill, run, false, () => {})
      expect(result, JSON.stringify({ root, result })).toMatchObject({
        state: 'succeeded',
        error: '',
      })
      expect(stored).toMatchObject({ title: '中文复用工单', owner: '张三' })
      expect(posts).toBe(2)
      const readOnly = await executor.execute(
        skill,
        { ...run, receipt: result.receipt },
        true,
        () => {},
      )
      expect(readOnly.state).toBe('succeeded')
      expect(posts).toBe(2)
      const noChange = await executor.execute(skill, { ...run, id: randomUUID() }, false, () => {})
      expect(noChange.state).toBe('no_change')
      expect(posts).toBe(2)
      rejectWrites = true
      const refused = {
        ...run,
        id: randomUUID(),
        receipt: JSON.stringify({ parameters: { title: 'Rejected task', owner: 'Carol' } }),
      }
      const failed = await executor.execute(skill, refused, false, () => {})
      expect(failed.state).toBe('needs_verification')
      expect(stored.title).toBe('中文复用工单')
      expect(posts).toBe(3)
      const verifyFailed = await executor.execute(
        skill,
        { ...refused, receipt: failed.receipt },
        true,
        () => {},
      )
      expect(verifyFailed.state).toBe('needs_verification')
      expect(posts).toBe(3)
      const canceled = {
        ...run,
        id: randomUUID(),
        receipt: JSON.stringify({ parameters: { title: 'Canceled task', owner: 'Dana' } }),
      }
      const cancellation = await executor.execute(skill, canceled, false, (state) => {
        if (state === 'reading') executor.cancel(canceled.id)
      })
      expect(cancellation.state).toBe('canceled')
      expect(posts).toBe(3)
      console.log(
        JSON.stringify({
          root,
          recording: ready.id,
          steps: ready.steps,
          result: result.state,
          actualRecord: stored,
          writeCount: posts,
          readOnlyVerification: readOnly.state,
        }),
      )
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      console.error(JSON.stringify({ root, recordings: workflows.list() }))
      throw error
    } finally {
      if (browser) await browser.close().catch(() => {})
      await workflows.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  360000,
)
