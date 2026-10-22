/* global window, document, innerWidth */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
const { _electron, chromium } = await import(
  process.env.ONE_ROOM_PLAYWRIGHT_MODULE || '@playwright/test'
)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const variant = metadata.version.includes('alpha') ? 'ml' : '001'
const bundle = path.join(
  root,
  variant === 'ml' ? 'dist/customer/mac-arm64/One Room.app' : 'release/mac-arm64/One Room.app',
)
const profile = await fs.mkdtemp(path.join(os.tmpdir(), `one-room-flow-desktop-${variant}-`))
const artifacts = path.join(root, '.desktop-acceptance')
await fs.mkdir(artifacts, { recursive: true })
let application,
  browser,
  stored = { title: 'Empty', owner: 'Nobody', revision: 0 },
  writes = 0
const errors = []
const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  if (request.url === '/record' && request.method === 'GET') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(stored))
    return
  }
  if (request.url === '/record' && request.method === 'POST') {
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    const value = JSON.parse(body)
    stored = { title: value.title, owner: value.owner, revision: stored.revision + 1 }
    writes++
    await fs.writeFile(path.join(profile, 'actual-record.json'), JSON.stringify(stored))
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(stored))
    return
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end(
    `<!doctype html><html><head><title>Local workflow acceptance</title><style>body{font:20px Arial;margin:80px;background:white;color:#222}label{display:block;margin:20px 0}input,button{font:20px Arial;padding:12px}h1{font-size:28px}</style></head><body><h1>Task assignment</h1><form><label>Title <input id="title" name="title"></label><label>Owner <input id="owner" name="owner"></label><button type="submit">Save</button></form><p id="status">Ready</p><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch('/record',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:document.querySelector('#title').value,owner:document.querySelector('#owner').value})});document.querySelector('#status').textContent='Saved'}</script></body></html>`,
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
async function until(read, check) {
  const deadline = Date.now() + 150000
  while (Date.now() < deadline) {
    const value = await read()
    if (check(value)) return value
    await delay(250)
  }
  throw new Error('桌面流程验收等待超时')
}
const invoke = (page, method, ...args) =>
  page.evaluate(
    ({ method, args }) => (window.mainWindowAPI?.oneRoom || window.oneRoom.reuse)[method](...args),
    { method, args },
  )
try {
  const environment = { ...process.env, ONE_ROOM_USER_DATA: profile, ONE_ROOM_VENDOR_SERVICES: '0' }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ONE_ROOM_WORKFLOW_RUNTIME
  application = await _electron.launch({
    executablePath: path.join(bundle, 'Contents/MacOS/One Room'),
    env: environment,
    timeout: 45000,
  })
  const page = await application.firstWindow()
  page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.mainWindowAPI?.oneRoom || window.oneRoom?.reuse))
  if (variant === 'ml') await page.getByRole('button', { name: 'SOP 工作台', exact: true }).click()
  else await page.getByTitle('流程', { exact: true }).click()
  await page.getByRole('heading', { name: 'SOP 工作台' }).waitFor()
  const agents = await invoke(page, 'agents')
  assert.equal(agents.find((item) => item.id === 'openadapt').enabled, true)
  assert.equal(agents.find((item) => item.id === 'claude').enabled, false)
  await page.getByRole('button', { name: '新建录制', exact: true }).click()
  await page.getByLabel('流程名称', { exact: true }).fill('本地工单分配')
  await page.getByLabel('起始页面地址', { exact: true }).fill(url)
  await page.getByLabel('可变字段名称', { exact: false }).fill('title,owner')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: '开始录制', exact: true }).click()
  await until(
    () => invoke(page, 'recordings'),
    (rows) => {
      if (rows[0]?.state === 'failed') throw new Error(rows[0].error)
      return rows[0]?.state === 'browser_ready'
    },
  )
  const port = (
    await fs.readFile(
      path.join(profile, 'agent-runs/workflows/browser-profile/DevToolsActivePort'),
      'utf8',
    )
  ).split('\n')[0]
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const target = browser.contexts()[0].pages()[0]
  await page.getByRole('button', { name: '开始记录操作', exact: true }).click()
  await until(
    () => invoke(page, 'recordings'),
    (rows) => rows[0]?.state === 'recording',
  )
  for (const [name, value] of [
    ['Title', 'Recorded task'],
    ['Owner', 'Alice'],
  ]) {
    await target.getByLabel(name, { exact: true }).click()
    await delay(700)
    await target.getByLabel(name, { exact: true }).fill(value)
    await delay(700)
    await target.keyboard.press('Tab')
    await delay(700)
  }
  await target.getByRole('button', { name: 'Save', exact: true }).click()
  await delay(1000)
  await target.getByText('Saved', { exact: true }).waitFor()
  await page.getByRole('button', { name: '结束录制', exact: true }).click()
  const [recording] = await until(
    () => invoke(page, 'recordings'),
    (rows) => {
      if (rows[0]?.state === 'failed') throw new Error(rows[0].error)
      return rows[0]?.state === 'ready'
    },
  )
  assert.ok(recording.steps >= 3)
  await page.getByRole('button', { name: '新建 SOP', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '确认 Skill' })
  await dialog.getByLabel('执行方式').selectOption('openadapt')
  await dialog.getByLabel('关联录制').selectOption(recording.id)
  await dialog.getByLabel('名称', { exact: true }).fill('中文流程验收')
  await dialog.getByLabel('用途', { exact: true }).fill('本地工单分配')
  await dialog.getByLabel('操作范围', { exact: true }).fill('仅隔离验收页面')
  await dialog.getByLabel('结果核验接口', { exact: false }).fill(url + 'record')
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: '确认并发布', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const [skill] = await invoke(page, 'skills')
  assert.equal(skill.workflow.digest, recording.digest)
  await page.getByRole('button', { name: '复用 v1', exact: true }).click()
  const runDialog = page.getByRole('dialog', { name: '复用流程' })
  await runDialog.getByLabel('title', { exact: true }).fill('中文自动复用工单')
  await runDialog.getByLabel('owner', { exact: true }).fill('张三')
  await runDialog.getByRole('checkbox').check()
  await runDialog.getByRole('button', { name: '开始执行', exact: true }).click()
  await runDialog.waitFor({ state: 'hidden' })
  const [run] = await until(
    () => invoke(page, 'runs'),
    (rows) => {
      if (rows[0] && ['failed', 'needs_verification'].includes(rows[0].state))
        throw new Error(JSON.stringify(rows[0]))
      return rows[0]?.state === 'succeeded'
    },
  )
  assert.deepEqual(stored, { title: '中文自动复用工单', owner: '张三', revision: 2 })
  assert.equal(writes, 2)
  assert.equal(JSON.parse(run.receipt).verified, true)
  await page
    .locator('.or-row strong')
    .filter({ hasText: /^成功 ·/ })
    .waitFor()
  for (const width of [1280, variant === 'ml' ? 720 : 390]) {
    await application.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 860),
      width,
    )
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    )
    await page.screenshot({
      path: path.join(artifacts, `workflow-${variant}-${width}.png`),
      fullPage: true,
    })
  }
  await page.getByTitle('发布新版本', { exact: true }).click()
  await dialog.getByLabel('结果核验接口', { exact: false }).fill('')
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: '确认并发布', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '复用 v2', exact: true }).click()
  await runDialog.getByLabel('title', { exact: true }).fill('人工核验工单')
  await runDialog.getByLabel('owner', { exact: true }).fill('李四')
  await runDialog.getByRole('checkbox').check()
  await runDialog.getByRole('button', { name: '开始执行', exact: true }).click()
  await runDialog.waitFor({ state: 'hidden' })
  const [uncertain] = await until(
    () => invoke(page, 'runs'),
    (rows) => {
      if (rows[0]?.state === 'failed') throw new Error(JSON.stringify(rows[0]))
      return rows[0]?.state === 'needs_verification'
    },
  )
  assert.deepEqual(stored, { title: '人工核验工单', owner: '李四', revision: 3 })
  await page.getByRole('button', { name: '人工核验', exact: true }).click()
  const reviewDialog = page.getByRole('dialog', { name: '人工核验', exact: true })
  await reviewDialog.getByRole('checkbox').check()
  await page.screenshot({ path: path.join(artifacts, `workflow-${variant}-manual-review.png`) })
  await reviewDialog.getByRole('button', { name: '确认核验完成', exact: true }).click()
  await reviewDialog.waitFor({ state: 'hidden' })
  const reviewed = (await invoke(page, 'runs')).find((row) => row.id === uncertain.id)
  assert.equal(reviewed.state, 'reviewed')
  assert.equal(JSON.parse(reviewed.receipt).manualReview.automaticVerification, false)
  assert.equal(writes, 3, '人工确认不能重放操作')
  await page
    .locator('.or-row strong')
    .filter({ hasText: /^已人工核验 ·/ })
    .waitFor()
  await application.close()
  application = null
  application = await _electron.launch({
    executablePath: path.join(bundle, 'Contents/MacOS/One Room'),
    env: environment,
    timeout: 45000,
  })
  const restarted = await application.firstWindow()
  await restarted.waitForFunction(() =>
    Boolean(window.mainWindowAPI?.oneRoom || window.oneRoom?.reuse),
  )
  const persisted = await invoke(restarted, 'runs')
  assert.equal(persisted.find((row) => row.id === uncertain.id).state, 'reviewed')
  assert.equal(persisted.find((row) => row.id === run.id).state, 'succeeded')
  assert.equal((await invoke(restarted, 'recordings'))[0].state, 'ready')
  assert.equal(writes, 3, '重启不能自动重放')
  assert.deepEqual(errors, [])
  const summary = {
    variant,
    status: 'passed',
    profile,
    bundle,
    recording: recording.id,
    steps: recording.steps,
    engine: 'OpenAdapt Flow 2.0.0',
    actualRecord: stored,
    writes,
    checks: [
      'packaged private Python and browser',
      'Chinese recording and SOP UI',
      'actual recording/compile',
      'immutable bundle',
      'parameter dialog',
      'Chinese parameter values reach the actual target',
      'real automatic browser write',
      'independent readback',
      'unverified replay never reports success',
      'explicit manual review without replay',
      'recording and receipts persist across restart',
      'Claude disabled',
      'supported minimum layout',
      'no renderer errors',
    ],
  }
  await fs.writeFile(
    path.join(artifacts, `workflow-${variant}.json`),
    JSON.stringify(summary, null, 2),
  )
  console.log(JSON.stringify(summary, null, 2))
} finally {
  if (browser) await browser.close().catch(() => {})
  if (application) await application.close()
  await new Promise((resolve) => server.close(resolve))
}
