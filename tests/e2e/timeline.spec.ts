import { test, expect, _electron as electron } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

let server: ChildProcess;
const url = 'http://127.0.0.1:5185';
test.use({ channel: 'chrome' });
test.beforeAll(async () => {
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'src/renderer', '--host', '127.0.0.1', '--port', '5185', '--strictPort'], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode != null) throw new Error('Fixture dev server exited.');
    try { if ((await fetch(url)).ok) return; } catch { /* wait for the dev listener */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Fixture dev server did not start.');
});
test.afterAll(() => { server?.kill(); });

test('fixture day/month/report/delete core flow at desktop and narrow widths', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${url}/?fixture=1`);
  await expect(page.getByLabel('活动片段').getByRole('button', { name: '选择 Kim 09:10:00', exact: true })).toBeVisible();
  await expect(page.getByText('原图缺失', { exact: true })).toBeVisible();
  const segments = page.locator('.period-segment');
  await expect(segments).toHaveCount(3);
  await expect.poll(async () => segments.evaluateAll(elements => {
    const widths = elements.map(element => Number.parseFloat((element as HTMLElement).style.width));
    return widths[2] / widths[1];
  })).toBeCloseTo(90);
  const widths = await segments.evaluateAll(elements => elements.map(element => Number.parseFloat((element as HTMLElement).style.width)));
  expect(widths[0] / widths[1]).toBeCloseTo(60);
  expect(widths[2] / widths[1]).toBeCloseTo(90);
  expect(widths.reduce((sum, width) => sum + width, 0)).toBeGreaterThan(40);
  await page.getByRole('button', { name: '选择 Kim 09:10:00', exact: true }).click();
  await expect(page.getByText('原图已过期', { exact: true })).toBeVisible();
  const assistantStart = await page.getByLabel('助手开始日期').inputValue();
  await page.getByRole('button', { name: '选择 Visual Studio Code 09:10:10', exact: true }).click();
  await page.getByRole('button', { name: '选择 Kim 09:10:00', exact: true }).click();
  await expect(page.locator('.cursor-label strong')).toHaveText('Kim');
  await expect(page.getByText('原图已过期', { exact: true })).toBeVisible();
  await page.waitForTimeout(350);
  await expect(page.locator('.cursor-label strong')).toHaveText('Kim');
  expect(await page.getByLabel('助手开始日期').inputValue()).toBe(assistantStart);
  await page.getByLabel('回看时间游标').fill(String(Date.parse('2026-10-15T09:26:00+08:00')));
  await expect(page.locator('.cursor-label strong')).toHaveText('未记录');
  await expect(page.locator('.evidence-image-area img')).toHaveCount(0);
  await mkdir('artifacts/acceptance', { recursive: true });
  await page.screenshot({ path: 'artifacts/acceptance/b-timeline-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '放大 Kim 09:10:00', exact: true }).click();
  await expect(page.locator('.zoom-label')).toHaveText('5分钟');
  await expect.poll(() => segments.nth(1).evaluate(element => Number.parseFloat((element as HTMLElement).style.width))).toBeCloseTo(10 / 300 * 100, 1);
  await page.getByRole('button', { name: '月', exact: true }).click();
  const day = page.getByLabel('2026-10-15 工作记录', { exact: true });
  await expect(day.locator('.month-entries > button')).toHaveCount(3);
  await page.screenshot({ path: 'artifacts/acceptance/b-month-desktop.png', fullPage: true });
  await day.getByRole('button', { name: '2026-10-15 日报', exact: true }).click();
  await page.getByRole('button', { name: '生成事实报告', exact: true }).click();
  await expect(page.locator('.report-rows article')).toHaveCount(3);
  await expect(page.locator('.report-totals').getByText('25分钟', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/acceptance/b-report-narrow.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '时间线', exact: true }).click();
  await expect(page.getByLabel('月历', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/acceptance/b-month-narrow.png', fullPage: true });
  await page.getByRole('button', { name: '日', exact: true }).click();
  await expect(page.locator('.cursor-label strong')).toHaveText('Kim');
  await page.screenshot({ path: 'artifacts/acceptance/b-timeline-narrow.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '预览删除', exact: true }).click();
  await expect(page.getByText('3 条观察 · 3 个片段 · 1 份报告', { exact: true })).toBeVisible();
  await page.getByLabel('确认删除所选历史及关联内容').check();
  await page.getByRole('button', { name: '删除历史', exact: true }).click();
  await expect(page.getByText('所选历史已删除', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '报告', exact: true }).click();
  await expect(page.getByText('来源已变更，报告已失效', { exact: true })).toBeVisible();
  await expect(page.locator('.report-rows article')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('controlled image loads and clears on gap, expiry, deletion and late replies', async () => {
  const application = await electron.launch({ args: ['tests/fixtures/evidence-window.mjs'], env: { ...process.env, ONE_ROOM_FIXTURE_URL: `${url}/?fixture=1` } });
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('原图缺失', { exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const modulePath = '/lib/desktop.ts';
      const { connectDesktopApi } = await import(modulePath) as typeof import('../../src/renderer/lib/desktop');
      const api = await connectDesktopApi(), original = api.timeline.resolveCursor;
      api.timeline.resolveCursor = async input => {
        const reply = await original(input);
        if (reply.ok && reply.data.period?.appBundleId === 'com.microsoft.VSCode' && reply.data.evidence) {
          reply.data.evidence.status = 'available';
          reply.data.evidence.url = `one-room-evidence://image/${reply.data.evidence.evidenceId}`;
        }
        return reply;
      };
    });
    await page.getByRole('button', { name: '刷新记录', exact: true }).click();
    const image = page.locator('.evidence-image-area img');
    await expect(image).toBeVisible();
    expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(320);
    await page.screenshot({ path: 'artifacts/acceptance/b-evidence-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/acceptance/b-evidence-narrow.png', fullPage: true });
    await page.getByRole('button', { name: '选择 Kim 09:10:00', exact: true }).click();
    await expect(page.getByText('原图已过期', { exact: true })).toBeVisible(); await expect(image).toHaveCount(0);
    await page.getByRole('button', { name: '选择 Visual Studio Code 09:10:10', exact: true }).click();
    await page.getByLabel('回看时间游标').fill(String(Date.parse('2026-10-15T09:26:00+08:00')));
    await page.waitForTimeout(350); await expect(image).toHaveCount(0);
    await expect(page.locator('.cursor-label strong')).toHaveText('未记录');
    await page.getByRole('button', { name: '选择 Visual Studio Code 09:00:00', exact: true }).click();
    await expect(image).toBeVisible();
    await page.evaluate(async () => {
      const modulePath = '/lib/desktop.ts';
      const { connectDesktopApi } = await import(modulePath) as typeof import('../../src/renderer/lib/desktop');
      const api = await connectDesktopApi();
      const preview = await api.history!.previewDelete({ rangeStart: Date.parse('2026-10-15T00:00:00+08:00'), rangeEnd: Date.parse('2026-10-16T00:00:00+08:00') });
      if (!preview.ok) throw new Error('Preview failed.');
      await api.history!.delete({ deletionRef: preview.data.deletionRef, expectedRevision: preview.data.dataRevision, confirmed: true, idempotencyKey: crypto.randomUUID() });
    });
    await expect(image).toHaveCount(0);
    await expect(page.locator('.period-list > div')).toHaveCount(0);
  } finally { await application.close(); }
});

test('a stale cursor revision refreshes the same date and cursor and restores its image', async () => {
  const application = await electron.launch({ args: ['tests/fixtures/evidence-window.mjs'], env: { ...process.env, ONE_ROOM_FIXTURE_URL: `${url}/?fixture=1` } });
  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel('活动片段', { exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const modulePath = '/lib/desktop.ts';
      const { connectDesktopApi } = await import(modulePath) as typeof import('../../src/renderer/lib/desktop');
      const api = await connectDesktopApi(), query = api.timeline.query, resolve = api.timeline.resolveCursor;
      const target = Date.parse('2026-10-15T09:10:10+08:00');
      let revisionOffset = 0, staleOnce = true;
      api.timeline.query = async input => {
        const reply = await query(input);
        if (reply.ok) { reply.data.dataRevision += revisionOffset; reply.dataRevision += revisionOffset; }
        return reply;
      };
      api.timeline.resolveCursor = async input => {
        if (input.cursorTs === target && staleOnce) {
          staleOnce = false; revisionOffset = 1;
          return { requestId: crypto.randomUUID(), ok: false, error: { code: 'STALE_REVISION', message: '记录已更新，请刷新。', retryable: false } };
        }
        const reply = await resolve({ ...input, queryRevision: input.queryRevision - revisionOffset });
        if (reply.ok) {
          reply.data.dataRevision += revisionOffset; reply.dataRevision += revisionOffset;
          if (reply.data.period?.appBundleId === 'com.microsoft.VSCode' && reply.data.evidence) {
            reply.data.evidence.status = 'available';
            reply.data.evidence.url = `one-room-evidence://image/${reply.data.evidence.evidenceId}`;
          }
        }
        return reply;
      };
    });
    await page.getByRole('button', { name: '刷新记录', exact: true }).click();
    await page.getByRole('button', { name: '选择 Visual Studio Code 09:00:00', exact: true }).click();
    const image = page.locator('.evidence-image-area img');
    await expect(image).toBeVisible();
    const firstUrl = await image.getAttribute('src');
    await page.getByRole('button', { name: '选择 Visual Studio Code 09:10:10', exact: true }).click();
    await expect(image).toBeVisible();
    await expect(image).not.toHaveAttribute('src', firstUrl!);
    await expect(image).toHaveAttribute('alt', 'Visual Studio Code 09:10:10 的画面');
    await expect(page.getByLabel('回看日期', { exact: true })).toHaveValue('2026-10-15');
    await expect(page.locator('.cursor-identity time')).toHaveText('09:10:10');
    await expect(page.locator('.cursor-label strong')).toHaveText('Visual Studio Code');
    await expect(page.locator('.track-caption')).toContainText('数据版本 2');
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { await application.close(); }
});

test('known activity stays readable and a month entry opens its exact period', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${url}/?fixture=1`);
  await expect(page.getByLabel('活动片段')).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = '/lib/desktop.ts';
    const { connectDesktopApi } = await import(modulePath) as typeof import('../../src/renderer/lib/desktop');
    const api = await connectDesktopApi();
    const enrich = <T extends { appBundleId: string }>(period: T): T => period.appBundleId === 'com.microsoft.VSCode' ? {
      ...period, action: 'suspected_edit', activityType: 'document', objectLabel: 'One Room 日报', topic: '采集链路',
      summary: '完成本地采集链路联调。', summaryStatus: 'ready', basis: 'confirmed',
    } : period;
    const query = api.timeline.query, resolve = api.timeline.resolveCursor, calendar = api.calendar.query;
    api.timeline.query = async input => { const reply = await query(input); if (reply.ok) reply.data.periods = reply.data.periods.map(enrich); return reply; };
    api.timeline.resolveCursor = async input => { const reply = await resolve(input); if (reply.ok && reply.data.period) reply.data.period = enrich(reply.data.period); return reply; };
    api.calendar.query = async input => { const reply = await calendar(input); if (reply.ok) reply.data.days = reply.data.days.map(day => ({ ...day, periods: day.periods.map(enrich) })); return reply; };
  });
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page.getByRole('button', { name: '选择 Visual Studio Code 09:00:00', exact: true }).click();
  const context = page.getByLabel('当前活动', { exact: true });
  await expect(context).toContainText('疑似编辑 · 文档');
  await expect(context).toContainText('One Room 日报');
  await expect(context).toContainText('采集链路');
  await expect(context.locator('.summary-copy')).toContainText('完成本地采集链路联调。');
  await page.getByRole('button', { name: '月', exact: true }).click();
  const entries = page.getByLabel('2026-10-15 工作记录', { exact: true }).locator('.month-entries > button');
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(2)).toContainText('疑似编辑 · 文档');
  await expect(entries.nth(2)).toContainText('完成本地采集链路联调。');
  await page.screenshot({ path: 'artifacts/acceptance/b-context-month-desktop.png', fullPage: true, scale: 'css' });
  await entries.nth(2).click();
  await expect(page.locator('.cursor-identity time')).toHaveText('09:10:10');
  await expect(context).toContainText('One Room 日报');
  await expect(page.getByText('原图缺失', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/acceptance/b-context-desktop.png', fullPage: true, scale: 'css' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/acceptance/b-context-narrow.png', fullPage: true, scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '月', exact: true }).click();
  await expect(entries.nth(2)).toContainText('完成本地采集链路联调。');
  await page.screenshot({ path: 'artifacts/acceptance/b-context-month-narrow.png', fullPage: true, scale: 'css' });
});

test('synthetic native swipes stay scoped to timeline focus or pointer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${url}/?fixture=1`);
  await expect(page.getByLabel('活动片段')).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = '/lib/desktop.ts';
    const { connectDesktopApi } = await import(modulePath) as typeof import('../../src/renderer/lib/desktop');
    const api = await connectDesktopApi();
    api.gestures = { subscribe: listener => {
      const receive = (event: Event) => listener((event as CustomEvent<import('../../src/shared/contracts').TimelineGesture>).detail);
      window.addEventListener('one-room-test-gesture', receive);
      return () => window.removeEventListener('one-room-test-gesture', receive);
    } };
  });
  await page.getByRole('button', { name: '报告', exact: true }).click();
  await page.getByRole('button', { name: '时间线', exact: true }).click();
  const emit = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('one-room-test-gesture', { detail: { kind: 'swipe', direction: 'up' } })));
  const zoomLabel = page.locator('.zoom-label');
  const original = await zoomLabel.textContent();
  await page.getByLabel('搜索记录').focus();
  await page.locator('.evidence-image-area').hover();
  await emit();
  await expect(zoomLabel).toHaveText(original!);
  await page.locator('input[type="date"]').first().focus();
  await emit();
  await expect(zoomLabel).toHaveText(original!);
  await page.locator('.navigation-surface').focus();
  await page.getByRole('button', { name: '设置', exact: true }).hover();
  await emit();
  await expect(zoomLabel).not.toHaveText(original!);
});
