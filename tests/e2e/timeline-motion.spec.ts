import { test, expect, _electron as electron } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

let server: ChildProcess;
const url = 'http://127.0.0.1:5186';
test.use({ channel: 'chrome' });
test.beforeAll(async () => {
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'src/renderer', '--host', '127.0.0.1', '--port', '5186', '--strictPort'], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode != null) throw new Error('Timeline motion fixture server exited.');
    try { if ((await fetch(url)).ok) return; } catch { /* Await fixture listener. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timeline motion fixture server unavailable.');
});
test.afterAll(() => { server?.kill(); });

test('wheel and pointer scrubbing keep a centered cursor and leave activity lists scrollable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${url}/?fixture=1`);
  const slider = page.getByLabel('回看时间游标');
  await expect(page.getByText('原图缺失', { exact: true })).toBeVisible();
  const original = Number(await slider.inputValue());
  const surface = page.getByLabel('选定时刻画面');
  await page.evaluate(async () => {
    const modulePath = '/lib/desktop.ts';
    const { connectDesktopApi } = await import(modulePath) as typeof import('../../src/renderer/lib/desktop');
    const api = await connectDesktopApi(), previous = api.timeline.resolveCursor;
    const counters = globalThis as typeof globalThis & { motionCursorRequests: number };
    counters.motionCursorRequests = 0;
    api.timeline.resolveCursor = async input => { counters.motionCursorRequests += 1; return previous(input); };
    const stage = document.querySelector('.evidence-stage')!;
    for (let index = 0; index < 100; index++) stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 0.01 }));
  });
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(original);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { motionCursorRequests: number }).motionCursorRequests)).toBeLessThanOrEqual(3);
  const scroll = await page.evaluate(() => window.scrollY);
  await surface.dispatchEvent('wheel', { deltaY: 2, deltaMode: 0 });
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(original);
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
  expect(await page.locator('.cursor-marker').evaluate(element => (element as HTMLElement).style.left)).toBe('50%');
  const afterWheel = Number(await slider.inputValue());
  await page.locator('.period-list').dispatchEvent('wheel', { deltaY: 80, deltaMode: 0 });
  await expect(slider).toHaveValue(String(afterWheel));
  const rail = await slider.boundingBox();
  if (!rail) throw new Error('Timeline rail unavailable.');
  await page.mouse.move(rail.x + rail.width / 2, rail.y + rail.height / 2);
  await page.mouse.down();
  await page.mouse.move(rail.x + rail.width / 2 + 20, rail.y + rail.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Number(await slider.inputValue())).toBeLessThan(afterWheel);
  await slider.press('Home');
  await expect(slider).toHaveValue(String(Date.parse('2026-10-15T09:00:00+08:00')));
  await slider.press('ArrowLeft');
  await expect(slider).toHaveValue(String(Date.parse('2026-10-15T09:00:00+08:00')));
  expect(await page.locator('.cursor-marker').evaluate(element => (element as HTMLElement).style.left)).toBe('50%');
  await mkdir('artifacts/acceptance', { recursive: true });
  await page.screenshot({ path: 'artifacts/acceptance/timeline-smooth-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.ruler-current')).toBeVisible();
  await page.screenshot({ path: 'artifacts/acceptance/timeline-smooth-narrow.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('pinch crosses day/month through fading tilted planes and preserves exact day selection', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${url}/?fixture=1`);
  await expect(page.getByText('原图缺失', { exact: true })).toBeVisible();
  const surface = page.getByLabel('时间回顾', { exact: true });
  for (let step = 0; step < 8 && await page.locator('.zoom-label').textContent() !== '24小时0分'; step++) await page.getByRole('button', { name: '缩小', exact: true }).first().click();
  await expect(page.locator('.zoom-label')).toHaveText('24小时0分');
  await surface.dispatchEvent('wheel', { deltaY: 240, deltaMode: 0, ctrlKey: true });
  await expect(page.locator('.review-planes')).toHaveAttribute('data-mode', 'month');
  await expect(page.locator('.review-day')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.review-month')).toHaveAttribute('aria-hidden', 'false');
  await expect.poll(() => page.locator('.review-month').evaluate(element => getComputedStyle(element).animationName)).toBe('month-plane-in');
  await page.screenshot({ path: 'artifacts/acceptance/timeline-month-transition.png' });
  await expect(page.locator('.review-day')).toBeHidden();
  const day = page.getByLabel('2026-10-15 工作记录', { exact: true });
  await expect(day.locator('.month-entries > button')).toHaveCount(3);
  await day.locator('.month-entries').dispatchEvent('wheel', { deltaY: 100 });
  await expect(page.locator('.review-planes')).toHaveAttribute('data-mode', 'month');
  await day.locator('.month-entries > button').filter({ hasText: 'Kim' }).click();
  await expect(page.locator('.review-planes')).toHaveAttribute('data-mode', 'day');
  await expect(page.getByLabel('回看时间游标')).toHaveValue(String(Date.parse('2026-10-15T09:10:00+08:00')));
  await expect(page.locator('.cursor-label strong')).toHaveText('Kim');
});

test('reduced motion changes views without a tilted animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${url}/?fixture=1`);
  await page.getByRole('button', { name: '月', exact: true }).click();
  await expect(page.getByLabel('月历', { exact: true })).toBeVisible();
  await expect(page.locator('.review-day')).toBeHidden();
  expect(await page.locator('.review-month').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
});

test('a short recording fills the rail and horizontal scrolling crosses midnight with changing image pixels', async () => {
  const application = await electron.launch({ args: ['tests/fixtures/evidence-window.mjs'], env: { ...process.env, ONE_ROOM_FIXTURE_URL: `${url}/?fixture=1` } });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByText('原图缺失', { exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const modulePath = '/lib/desktop.ts';
      const { connectDesktopApi } = await import(modulePath) as typeof import('../../src/renderer/lib/desktop');
      const api = await connectDesktopApi();
      const query = api.timeline.query, resolve = api.timeline.resolveCursor;
      const source = await query({ rangeStart: Date.parse('2026-10-15T00:00:00+08:00'), rangeEnd: Date.parse('2026-10-16T00:00:00+08:00') });
      if (!source.ok) throw new Error('Fixture unavailable.');
      const start = Date.parse('2026-10-15T23:59:00+08:00'), end = start + 180_000;
      const originals = [source.data.periods[0], source.data.periods[2]];
      const periods = originals.map((p, index) => ({ ...p, startTs: start + index * 60_000, endTs: index ? end : start + 60_000, appName: index ? '第二段工作' : '第一段工作' }));
      api.timeline.query = async input => {
        const reply = await query(input);
        if (reply.ok) {
          reply.data.periods = periods.filter(p => p.startTs < input.rangeEnd && p.endTs > input.rangeStart).map(p => ({ ...p, startTs: Math.max(p.startTs, input.rangeStart), endTs: Math.min(p.endTs, input.rangeEnd) }));
          reply.data.gaps = []; reply.data.nextCursor = null;
          reply.data.recordingRange = { rangeStart: start, rangeEnd: end };
          reply.data.coverage = { rangeStart: input.rangeStart, rangeEnd: input.rangeEnd, recordedMs: reply.data.periods.reduce((n, p) => n + p.endTs - p.startTs, 0), gapMs: 0 };
        }
        return reply;
      };
      api.timeline.resolveCursor = async input => {
        const index = input.cursorTs < start + 60_000 ? 0 : 1;
        const reply = await resolve({ ...input, cursorTs: originals[index].startTs });
        if (reply.ok) {
          reply.data.cursorTs = input.cursorTs; reply.data.period = periods[index]; reply.data.gap = null;
          if (reply.data.evidence) reply.data.evidence = { ...reply.data.evidence, status: 'available', observedAt: periods[index].startTs, displayUntil: periods[index].endTs, url: `one-room-evidence://image/${reply.data.evidence.evidenceId}` };
        }
        return reply;
      };
    });
    await page.getByRole('button', { name: '刷新记录', exact: true }).click();
    const slider = page.getByLabel('回看时间游标');
    await expect(slider).toHaveAttribute('min', String(Date.parse('2026-10-15T23:59:00+08:00')));
    await slider.fill(String(Date.parse('2026-10-15T23:59:30+08:00')));
    await page.getByRole('button', { name: '适配录制范围', exact: true }).click();
    await expect.poll(async () => page.locator('.period-segment').evaluateAll(elements => elements.reduce((sum, element) => sum + Number.parseFloat((element as HTMLElement).style.width), 0))).toBeGreaterThan(50);
    const image = page.locator('.evidence-image-area img');
    await expect(image).toHaveAttribute('alt', '第一段工作 23:59:00 的画面');
    const firstPixels = await image.screenshot();
    const firstUrl = await image.getAttribute('src');
    await page.getByLabel('选定时刻画面').dispatchEvent('wheel', { deltaX: 180, deltaY: 1, deltaMode: 0 });
    await expect(page.getByLabel('回看日期', { exact: true })).toHaveValue('2026-10-16');
    await expect(page.locator('.cursor-label strong')).toHaveText('第二段工作');
    await expect(image).toHaveAttribute('alt', '第二段工作 00:00:00 的画面');
    await expect(image).not.toHaveAttribute('src', firstUrl!);
    expect(Buffer.compare(firstPixels, await image.screenshot())).not.toBe(0);
    await mkdir('artifacts/acceptance', { recursive: true });
    await page.screenshot({ path: 'artifacts/acceptance/timeline-continuous-midnight.png', fullPage: true });
    await page.getByLabel('选定时刻画面').dispatchEvent('wheel', { deltaX: -180, deltaMode: 0 });
    await expect(page.getByLabel('回看日期', { exact: true })).toHaveValue('2026-10-15');
    await expect(image).toHaveAttribute('src', firstUrl!);
    await slider.fill(String(Date.parse('2026-10-15T23:59:59.500+08:00')));
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await expect(page.getByLabel('回看日期', { exact: true })).toHaveValue('2026-10-16');
    await expect(image).toHaveAttribute('alt', '第二段工作 00:00:00 的画面');
    await page.getByRole('button', { name: '暂停播放', exact: true }).click();
    await page.getByRole('button', { name: '回到最新记录', exact: true }).click();
    await slider.press('End'); await slider.press('ArrowRight');
    await expect(slider).toHaveValue(String(Date.parse('2026-10-16T00:02:00+08:00') - 1));
    await page.getByLabel('选定时刻画面').dispatchEvent('wheel', { deltaX: 10_000, deltaMode: 0 });
    await expect(slider).toHaveValue(String(Date.parse('2026-10-16T00:02:00+08:00') - 1));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(image).toBeVisible();
    await page.screenshot({ path: 'artifacts/acceptance/timeline-continuous-narrow.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await application.close(); }
});
