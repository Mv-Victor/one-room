import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DomainMethod, MethodInput, MethodOutput, Reply } from '../../src/shared/contracts';
import { dateKey, dayBounds, DAY_MS } from '../../src/shared/time';

type Seed = {
  synthetic: true; dateKey: string; rangeStart: number; rangeEnd: number; token: string;
  observations: { id: string; evidenceId: string; at: number }[];
  imagePath: string; recordedMs: number; imageWidth: number; imageHeight: number;
};

async function seedHistory(directory: string, key: string): Promise<Seed> {
  const electronPath = createRequire(import.meta.url)('electron') as string;
  const child = spawn(electronPath, [resolve('tests/fixtures/seed-production-worklog.mjs'), resolve('out/main/database.js'), directory, key], {
    cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostic = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { diagnostic += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostic += chunk; });
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Synthetic history seeder timed out.')); }, 25_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolveExit();
      else reject(new Error(`Synthetic history seeder failed (${code}): ${diagnostic}`));
    });
  });
  return JSON.parse(await readFile(join(directory, 'production-worklog-fixture.json'), 'utf8')) as Seed;
}

async function rpc<M extends DomainMethod>(page: Page, method: M, input: MethodInput<M>): Promise<MethodOutput<M>> {
  const reply = await page.evaluate(({ method, input }) => {
    const [group, name] = method.split('.');
    const api = window.oneRoom as unknown as Record<string, Record<string, (value: unknown) => Promise<Reply<unknown>>>>;
    return api[group][name](input);
  }, { method, input });
  if (!reply.ok) throw new Error(`${method}: ${reply.error.code} ${reply.error.message}`);
  return reply.data as MethodOutput<M>;
}

test('production SQLite history drives timeline, calendar, reports, restart and deletion UI', async () => {
  const testInfo = test.info();
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'one-room-production-worklog-'));
  const key = dateKey(Date.now() - DAY_MS), range = dayBounds(key);
  const errors: string[] = [];
  let application: ElectronApplication | undefined;
  const close = async () => {
    const active = application; application = undefined;
    if (!active) return;
    const child = active.process();
    try { await active.close(); }
    finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  };
  const launch = async () => {
    const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ONE_ROOM_USER_DATA: userData };
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ args: [process.cwd()], env, timeout: 20_000 });
    expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(userData);
    const page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.getByText('本地已连接', { exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.has('fixture')).toBe(false);
    expect((await rpc(page, 'app.getStatus', {})).capture.state).toBe('paused');
    expect((await rpc(page, 'settings.get', {})).textConsent.enabled).toBe(false);
    await page.getByLabel('回看日期', { exact: true }).fill(key);
    return page;
  };
  try {
    const seed = await seedHistory(userData, key);
    expect(seed.synthetic).toBe(true);
    let page = await launch();
    const periods = page.getByLabel('活动片段', { exact: true });
    await expect(periods.locator('.period-list > div')).toHaveCount(3);
    const timeline = await rpc(page, 'timeline.query', range);
    expect(timeline.periods.map(period => period.appName)).toEqual(['Synthetic Editor', 'Kim', 'Synthetic Editor']);
    expect(timeline.periods.map(period => period.endTs - period.startTs)).toEqual([600_000, 10_000, 900_000]);
    expect(timeline.coverage.recordedMs).toBe(seed.recordedMs);
    expect((await rpc(page, 'activity.query', {})).items.every(item => item.text?.includes(seed.token))).toBe(true);

    await periods.getByRole('button', { name: '选择 Synthetic Editor 09:00:00', exact: true }).click();
    const context = page.getByLabel('当前活动', { exact: true });
    await expect(context).toContainText('Synthetic Daily Document');
    await expect(context).toContainText('Capture Integration');
    await expect(context).toContainText('疑似编辑 · 文档');
    const image = page.locator('.evidence-image-area img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(element => ({ complete: (element as HTMLImageElement).complete, width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight })))
      .toEqual({ complete: true, width: seed.imageWidth, height: seed.imageHeight });
    const evidenceUrl = await image.getAttribute('src');
    expect(evidenceUrl).toContain(seed.observations[0].evidenceId);
    const cursor = await rpc(page, 'timeline.resolveCursor', { cursorTs: seed.observations[0].at + 5000, queryRevision: timeline.dataRevision });
    expect(cursor.observation?.id).toBe(seed.observations[0].id);
    expect(cursor.evidence?.status).toBe('available');
    await periods.getByRole('button', { name: '选择 Kim 09:10:00', exact: true }).click();
    await expect(periods.getByRole('button', { name: '选择 Kim 09:10:00', exact: true }).locator('.period-duration')).toHaveText('10秒');
    await expect(context).toContainText('Synthetic Room Group');
    await expect(context).toContainText('Ten Second Interruption');
    await page.getByLabel('回看时间游标', { exact: true }).fill(String(seed.observations[1].at + 5000));
    await expect(page.locator('.cursor-identity time')).toHaveText('09:10:05');
    await expect(page.locator('.cursor-label strong')).toHaveText('Kim');
    await expect(image).toHaveAttribute('src', new RegExp(seed.observations[1].evidenceId));
    await periods.getByRole('button', { name: '选择 Synthetic Editor 09:10:10', exact: true }).click();
    await expect(context).toContainText('Synthetic Daily Document');
    await expect(image).toHaveAttribute('src', new RegExp(seed.observations[2].evidenceId));
    await page.screenshot({ path: testInfo.outputPath('production-synthetic-timeline.png'), fullPage: true });

    await page.getByRole('button', { name: '月', exact: true }).click();
    let day = page.getByLabel(`${key} 工作记录`, { exact: true });
    await expect(day.locator('.month-entries > button')).toHaveCount(3);
    await expect(day.locator('.month-entries > button').nth(2)).toContainText('Capture Integration');
    await day.locator('.month-entries > button').filter({ hasText: 'Kim' }).click();
    await expect(page.getByLabel('回看日期', { exact: true })).toHaveValue(key);
    await expect(page.locator('.cursor-identity time')).toHaveText('09:10:00');
    await expect(page.locator('.cursor-label strong')).toHaveText('Kim');
    await expect(image).toHaveAttribute('src', new RegExp(seed.observations[1].evidenceId));

    await page.getByRole('button', { name: '月', exact: true }).click();
    day = page.getByLabel(`${key} 工作记录`, { exact: true });
    await day.getByRole('button', { name: `${key} 日报`, exact: true }).click();
    const report = page.getByLabel('工作报告', { exact: true });
    await expect(report.getByLabel('报告日期', { exact: true })).toHaveValue(key);
    await report.getByRole('button', { name: '生成事实报告', exact: true }).click();
    await expect(report.getByLabel('时间分配', { exact: true })).toBeVisible();
    await expect(report.getByLabel('工作节奏', { exact: true }).locator('.report-rhythm-day')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('production-report-review.png'), fullPage: true });
    const exportPath = testInfo.outputPath('daily-review.html');
    await application!.evaluate(({ session }, path) => {
      session.defaultSession.once('will-download', (_event, item) => item.setSavePath(path));
    }, exportPath);
    await report.getByRole('button', { name: '导出 HTML', exact: true }).click();
    await expect.poll(async () => { try { return (await readFile(exportPath, 'utf8')).includes('来源简表'); } catch { return false; } }).toBe(true);
    const reportHtml = await readFile(exportPath, 'utf8');
    expect(reportHtml).toContain('Synthetic Daily Document');
    expect(reportHtml).not.toMatch(/<(?:script|img)\b/i);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('production-report-review-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await report.getByRole('button', { name: '事实', exact: true }).click();
    await expect(report.locator('.report-facts')).toBeVisible();
    await expect(report.locator('.report-rows article')).toHaveCount(3);
    await expect(report.locator('.report-rows article').filter({ hasText: 'Kim' }).locator(':scope > strong')).toHaveText('10秒');
    const daily = await rpc(page, 'report.get', { kind: 'daily', dateKey: key });
    expect(daily.status).toBe('ready');
    expect(daily.report?.recordedMs).toBe(seed.recordedMs);
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    await page.getByLabel(`${key} 工作记录`, { exact: true }).getByRole('button', { name: `${key} 所在周周报`, exact: true }).click();
    await expect(report.getByRole('button', { name: '周报', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await report.getByRole('button', { name: '生成事实报告', exact: true }).click();
    await report.getByRole('button', { name: '回顾', exact: true }).click();
    await expect(report.getByLabel('工作节奏', { exact: true }).locator('.report-rhythm-day')).toHaveCount(7);
    await page.screenshot({ path: testInfo.outputPath('production-weekly-review.png'), fullPage: true });
    await expect(report.locator('.report-rows article')).toHaveCount(3);
    const weekly = await rpc(page, 'report.get', { kind: 'weekly', dateKey: key });
    expect(weekly.status).toBe('ready');
    expect(weekly.report?.recordedMs).toBe(seed.recordedMs);

    await close();
    page = await launch();
    expect((await rpc(page, 'report.get', { kind: 'daily', dateKey: key })).report?.id).toBe(daily.report?.id);
    expect((await rpc(page, 'report.get', { kind: 'weekly', dateKey: key })).report?.id).toBe(weekly.report?.id);
    await page.getByRole('button', { name: '当日日报', exact: true }).click();
    await expect(page.getByLabel('工作报告', { exact: true }).locator('.report-rows article')).toHaveCount(3);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const history = page.getByLabel('删除历史', { exact: true });
    await history.getByLabel('删除开始日期', { exact: true }).fill(key);
    await history.getByLabel('删除结束日期', { exact: true }).fill(dateKey(range.rangeEnd));
    await history.getByRole('button', { name: '预览删除', exact: true }).click();
    await expect(history.getByText('3 条观察 · 3 个片段 · 2 份报告', { exact: true })).toBeVisible();
    expect((await rpc(page, 'app.getStatus', {})).capture.state).toBe('paused');
    expect((await rpc(page, 'settings.get', {})).captureEnabled).toBe(false);
    await history.getByLabel('确认删除所选历史及关联内容', { exact: true }).check();
    await history.getByRole('button', { name: '删除历史', exact: true }).click();
    await expect(history.getByText('所选历史已删除', { exact: true })).toBeVisible();

    expect((await rpc(page, 'activity.query', {})).items).toEqual([]);
    expect((await rpc(page, 'timeline.query', { ...range, query: seed.token })).periods).toEqual([]);
    expect(await rpc(page, 'report.get', { kind: 'daily', dateKey: key })).toEqual({ status: 'invalidated', report: null });
    expect(await rpc(page, 'report.get', { kind: 'weekly', dateKey: key })).toEqual({ status: 'invalidated', report: null });
    expect(await application!.evaluate(async ({ net }, url) => (await net.fetch(url!)).status, evidenceUrl)).toBe(404);
    await expect.poll(async () => { try { await access(seed.imagePath); return true; } catch { return false; } }).toBe(false);
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    await page.getByRole('button', { name: '日', exact: true }).click();
    await expect(page.locator('.period-list > div')).toHaveCount(0);
    await expect(page.locator('.evidence-image-area img')).toHaveCount(0);
    await page.getByLabel('搜索记录', { exact: true }).fill(seed.token);
    await expect(page.locator('.period-list > div')).toHaveCount(0);
    await page.getByLabel('搜索记录', { exact: true }).fill('');
    await page.getByRole('button', { name: '月', exact: true }).click();
    await expect(page.getByLabel(`${key} 工作记录`, { exact: true }).locator('.month-entries > button')).toHaveCount(0);
    await page.getByLabel(`${key} 工作记录`, { exact: true }).getByRole('button', { name: `${key} 日报`, exact: true }).click();
    await expect(page.getByText('来源已变更，报告已失效', { exact: true })).toBeVisible();
    await page.getByLabel('工作报告', { exact: true }).getByRole('button', { name: '周报', exact: true }).click();
    await expect(page.getByText('来源已变更，报告已失效', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('local document UI publishes a version and reviews frozen input without automatic model dispatch', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'one-room-production-worklog-document-'));
  const key = dateKey(Date.now() - DAY_MS), targetPath = join(userData, 'daily.md');
  const before = `# Worklog\n\n## ${key}\n\n- Existing progress.\n\n## Notes\n\nKeep these bytes.\n`;
  let application: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    const seed = await seedHistory(userData, key);
    await writeFile(targetPath, before);
    const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ONE_ROOM_USER_DATA: userData };
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await electron.launch({ args: [process.cwd()], env });
    await application.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [path] }) });
    }, targetPath);
    const page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.getByText('本地已连接', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '流程', exact: true }).click();
    await page.getByRole('button', { name: '文档更新', exact: true }).click();
    const rules = page.getByLabel('文档规则', { exact: true });
    await rules.getByLabel('名称', { exact: true }).fill('Daily local rule');
    await rules.getByLabel('类型', { exact: true }).selectOption('daily');
    await rules.getByRole('button', { name: '选择文件', exact: true }).click();
    await expect(rules.getByLabel('目标章节', { exact: true }).locator('option')).toHaveCount(4);
    await rules.getByLabel('目标章节', { exact: true }).selectOption({ label: key });
    await expect(rules.getByLabel('当前目标章节', { exact: true })).toContainText('Existing progress.');
    await rules.getByLabel('更新要求', { exact: true }).fill('Use only selected facts. Keep existing heading.');
    await rules.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(rules.getByRole('button', { name: '发布新版本', exact: true })).toBeDisabled();
    for (const label of ['目标文档正确', '章节范围正确', '格式与去重规则正确']) await rules.getByLabel(label, { exact: true }).check();
    await rules.getByRole('button', { name: '发布新版本', exact: true }).click();
    const preparation = page.getByLabel('准备文档更新', { exact: true });
    await expect(preparation.getByLabel('不可变规则版本', { exact: true })).not.toHaveValue('');
    await preparation.locator('.document-source input').first().check();
    await preparation.getByRole('button', { name: '准备输入审核', exact: true }).click();
    const review = page.getByLabel('执行审核', { exact: true });
    await expect(review.getByLabel('完整待发送输入', { exact: true })).toContainText(seed.token);
    await expect(review.getByLabel('完整待发送输入', { exact: true })).not.toContainText(userData);
    await expect(review.getByRole('button', { name: '发送给 Codex', exact: true })).toBeDisabled();
    expect((await rpc(page, 'run.list', {}))[0].state).toBe('awaiting_input_confirmation');
    expect(await readFile(targetPath, 'utf8')).toBe(before);
    await page.screenshot({ path: test.info().outputPath('document-input-review.png'), fullPage: true });
    await review.getByRole('button', { name: '取消任务', exact: true }).click();
    await expect(review.getByRole('status')).toHaveText('已取消');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByLabel('Agent 设置', { exact: true })).toBeVisible();
    await expect(page.getByLabel('同意 Codex 合成能力测试', { exact: true })).not.toBeChecked();
    expect(errors).toEqual([]);
  } finally {
    if (application) {
      const child = application.process();
      try { await application.close(); } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    }
    await rm(userData, { recursive: true, force: true });
  }
});
