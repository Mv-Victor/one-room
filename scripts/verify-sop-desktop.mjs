/* global window, document, innerWidth, innerHeight */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const { _electron } = await import(process.env.ONE_ROOM_PLAYWRIGHT_MODULE || '@playwright/test')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const variant = metadata.version.includes('alpha') ? 'ml' : '001'
const bundle = path.join(
  root,
  variant === 'ml' ? 'dist/customer/mac-arm64/One Room.app' : 'release/mac-arm64/One Room.app',
)
const executable = path.join(bundle, 'Contents/MacOS/One Room')
const profile = await fs.mkdtemp(path.join(os.tmpdir(), `one-room-${variant}-desktop-`))
const artifacts = path.join(root, '.desktop-acceptance')
await fs.mkdir(artifacts, { recursive: true })
const errors = []
let application
const environment = { ...process.env, ONE_ROOM_USER_DATA: profile, ONE_ROOM_VENDOR_SERVICES: '0' }
delete environment.ELECTRON_RUN_AS_NODE
const launch = async () => {
  application = await _electron.launch({
    executablePath: executable,
    env: environment,
    timeout: 45000,
  })
  const page = await application.firstWindow({ timeout: 30000 })
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.mainWindowAPI?.oneRoom || window.oneRoom?.reuse))
  await page.waitForLoadState('domcontentloaded')
  return page
}
const invoke = (page, method, args = []) =>
  page.evaluate(
    ({ method, args }) => {
      const api = window.mainWindowAPI?.oneRoom || window.oneRoom.reuse
      return api[method](...args)
    },
    { method, args },
  )
try {
  let page = await launch()
  if (variant === 'ml') {
    await page.getByRole('button', { name: '活动记录', exact: true }).click()
    await page.getByRole('heading', { name: '活动记录', exact: true }).waitFor()
    await page.getByPlaceholder('搜索应用、标题或摘要').waitFor()
    await page.screenshot({ path: path.join(artifacts, 'chinese-activities.png') })
    await page.getByRole('button', { name: '行为模式', exact: true }).click()
    await page.getByRole('heading', { name: '行为模式', exact: true }).waitFor()
    await page.screenshot({ path: path.join(artifacts, 'chinese-patterns.png') })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor()
    await page.getByRole('tab', { name: '采集与隐私', exact: true }).waitFor()
  }
  await invoke(page, 'candidates')
  await application.close()
  application = null
  const database = path.join(profile, variant === 'ml' ? 'one-room.db' : 'one-room.sqlite')
  const seed = `
    const Database=require(${JSON.stringify(path.join(root, 'node_modules/better-sqlite3'))});
    const db=new Database(process.argv[1]);
    const {randomUUID}=require('node:crypto');
    const target='https://docs.corp.kuaishou.com/d/home/desktop-acceptance';
    for(let n=1;n<=2;n++) {
      const at=Date.UTC(2026,9,10+n,2);
      if(${JSON.stringify(variant)}==='ml') {
        db.prepare('INSERT INTO or_periods(id,start,end,app,title,url,kind,action,object,topic,summary) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(),at,at+60000,'Docs','验收日报',target,'document','编辑文档','验收日报','更新日报','更新验收记录');
      } else {
        const capture=randomUUID();
        db.prepare("INSERT INTO capture_events(id,sessionId,observedAt,endTs,bundleId,appName,pid,windowId,windowTitle,trigger,captureGeneration,pairingStatus,visibilityStatus) VALUES(?,?,?,?,?,?,1,1,?,'manual',1,'matched','verified')")
          .run(capture,randomUUID(),at,at+60000,'local.one-room.acceptance','Docs','验收日报 '+target);
        db.prepare("INSERT INTO activity_events(id,captureEventId,action,basis,activityType,objectLabel,topic,summary) VALUES(?,?,'suspected_edit','confirmed','document','验收日报','更新日报','更新验收记录')").run(randomUUID(),capture);
      }
    }
    for(let n=1;n<=2;n++) {
      const at=Date.UTC(2026,9,14,2,n*5), object=n===1?'For GMV':'For ROI';
      const recipe=n===1?'选择目标GMV，设置预算100，保存草稿':'选择目标ROI，设置预算200，保存草稿';
      if(${JSON.stringify(variant)}==='ml') {
        db.prepare('INSERT INTO or_periods(id,start,end,app,title,url,kind,action,object,topic,summary) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(),at,at+60000,'Chrome','云舵策略配置','','other','配置',object,'策略配置',recipe);
      } else {
        const capture=randomUUID();
        db.prepare("INSERT INTO capture_events(id,sessionId,observedAt,endTs,bundleId,appName,pid,windowId,windowTitle,trigger,captureGeneration,pairingStatus,visibilityStatus) VALUES(?,?,?,?,?,?,1,1,?,'manual',1,'matched','verified')")
          .run(capture,randomUUID(),at,at+60000,'local.one-room.acceptance','Chrome','云舵策略配置');
        db.prepare("INSERT INTO activity_events(id,captureEventId,action,basis,activityType,objectLabel,topic,summary) VALUES(?,?,'suspected_edit','confirmed','other',?,'策略配置',?)").run(randomUUID(),capture,object,recipe);
      }
    }
    db.close();
  `
  const result = spawnSync(
    path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    ['-e', seed, database],
    { env: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  page = await launch()
  await page.getByTitle('查看 SOP 候选').click({ timeout: 20000 })
  await page.getByRole('heading', { name: 'SOP 工作台' }).waitFor()
  await page.getByText('2 次独立操作', { exact: false }).first().waitFor()
  const candidate = (await invoke(page, 'candidates')).find((row) => row.kind === 'document')
  assert.equal(candidate.instances, 2)
  const claude = page.locator('.or-row').filter({ has: page.getByText('Claude', { exact: true }) })
  await claude.getByRole('button', { name: '检测' }).waitFor({ timeout: 25000 })
  assert.equal(await claude.getByRole('button').isDisabled(), true)
  await page.screenshot({ path: path.join(artifacts, 'workbench-desktop.png'), fullPage: true })
  await page
    .locator('.or-row')
    .filter({ hasText: candidate.title })
    .getByTitle('接受并确认规则')
    .click()
  const dialog = page.getByRole('dialog', { name: '确认 Skill' })
  assert.equal(await dialog.getByLabel('目标公司 Docs URL').inputValue(), candidate.target)
  await dialog.getByLabel('名称', { exact: true }).fill('桌面验收日报 Skill')
  await dialog.getByLabel('目标章节与范围').fill('仅验收章节')
  await dialog.getByLabel('事实来源范围').fill('仅用户指定的验收事实，不读取工作记录')
  await dialog.getByRole('checkbox').check()
  await dialog.getByLabel('目标公司 Docs URL').fill('https://invalid.example/d/home/blocked')
  await dialog.getByRole('button', { name: '确认并发布' }).click()
  await dialog.getByRole('alert').waitFor()
  assert.equal((await invoke(page, 'skills')).length, 0)
  await dialog.getByLabel('目标公司 Docs URL').fill(candidate.target)
  await dialog.getByRole('button', { name: '确认并发布' }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('alert').count(), 0)
  const [v1] = await invoke(page, 'skills')
  assert.equal(v1.version, 1)
  await page.getByTitle('发布新版本').click()
  await dialog.getByLabel('目标章节与范围').fill('仅验收章节 v2')
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: '确认并发布' }).click()
  await dialog.waitFor({ state: 'hidden' })
  const versions = await invoke(page, 'skills')
  assert.equal(versions.length, 2)
  assert.equal(versions.find((item) => item.version === 1).scope, '仅验收章节')
  const strategy = (await invoke(page, 'candidates')).find((row) => row.kind === 'strategy')
  assert.equal(strategy.instances, 2)
  await page
    .locator('.or-row')
    .filter({ hasText: strategy.title })
    .getByTitle('接受并确认规则')
    .click()
  const rule = page.getByRole('dialog', { name: '策略规则' })
  assert.equal(
    await rule.getByLabel('步骤', { exact: true }).inputValue(),
    strategy.pattern.steps.join('\n'),
  )
  for (const [label, value] of [
    ['名称', '桌面验收策略'],
    ['步骤', '选择目标；设置预算；保存草稿'],
    ['变量', '目标、预算'],
    ['前提', '已登录测试环境'],
    ['审批点', '人工验收'],
  ])
    await rule.getByLabel(label, { exact: true }).fill(value)
  await rule.getByRole('button', { name: '保存规则' }).click()
  await rule.waitFor({ state: 'hidden' })
  assert.equal((await invoke(page, 'rules')).length, 1)
  assert.equal((await invoke(page, 'runs')).length, 0)
  for (const size of [
    { width: 1280, height: 860 },
    { width: variant === 'ml' ? 720 : 390, height: 844 },
  ]) {
    await application.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
      size,
    )
    await page.getByRole('button', { name: '新建 SOP' }).click()
    await dialog.waitFor()
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
      false,
      'horizontal overflow',
    )
    const box = await dialog.boundingBox()
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    assert.ok(
      box.x >= 0 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y >= 0 &&
        box.y + box.height <= viewport.height + 1,
      'dialog outside viewport',
    )
    await page.screenshot({ path: path.join(artifacts, `skill-dialog-${size.width}.png`) })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
  }
  await application.close()
  application = null
  page = await launch()
  assert.equal((await invoke(page, 'skills')).length, 2)
  assert.equal((await invoke(page, 'rules')).length, 1)
  assert.equal((await invoke(page, 'candidates'))[0].status, 'accepted')
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        variant,
        bundle,
        profile,
        artifacts,
        checks: [
          'packaged app launch',
          'real preload and IPC',
          'automatic discovery notice',
          'independent updates',
          'Claude disabled',
          'Skill form and immutable versions',
          'invalid URL rejection and recovery',
          'strategy preview',
          'no unattended run',
          'native minimum and desktop layout',
          'Escape closes modal',
          'restart persistence',
          'no renderer exceptions',
        ],
      },
      null,
      2,
    ),
  )
} finally {
  if (application) await application.close()
}
