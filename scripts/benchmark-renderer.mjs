import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from '@playwright/test';

const root = resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'one-room-renderer-benchmark-'));
const artifacts = join(root, 'artifacts/acceptance');
const dayMs = 86_400_000, dateKey = value => new Date(value + 8 * 3_600_000).toISOString().slice(0, 10);
const time = value => new Date(value + 8 * 3_600_000).toISOString().slice(11, 19);
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const round = value => Math.round(value * 100) / 100;
const stats = values => ({ count: values.length, p50Ms: round(percentile(values, 0.5)), p95Ms: round(percentile(values, 0.95)), maxMs: round(Math.max(...values)) });
let application;
let progress = 'seed';
const pageErrors = [];

async function seed() {
  const child = spawn(require('electron'), [join(root, 'out/main/navigationBenchmark.js'), '--seed-renderer', directory], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let diagnostics = '';
  child.stdout.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4_000); });
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4_000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolveExit() : reject(new Error(`Benchmark seed failed (${code}): ${diagnostics}`)));
    });
  } finally { clearTimeout(timer); }
  return JSON.parse(await readFile(join(directory, 'benchmark-metadata.json'), 'utf8'));
}

async function painted(page) {
  await page.waitForFunction(() => !globalThis.document.querySelector('.review-planes[data-transition]'), undefined, { timeout: 2_500, polling: 'raf' });
  await page.evaluate(() => new Promise(resolvePaint => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolvePaint))));
}

async function run() {
  const fixture = await seed();
  await mkdir(artifacts, { recursive: true });
  const env = { ...process.env, ONE_ROOM_USER_DATA: directory };
  delete env.ELECTRON_RENDERER_URL; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [root], env, timeout: 30_000 });
  const page = await application.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByText('本地已连接', { exact: true }).waitFor();
  const months = new Map();
  for (let day = 0; day < 30; day++) {
    const key = dateKey(fixture.rangeStart + day * dayMs), count = Math.min(fixture.periodsPerDay, fixture.periods - day * fixture.periodsPerDay);
    const previous = months.get(key.slice(0, 7)) ?? { count: 0 };
    months.set(key.slice(0, 7), { count: previous.count + count, date: key, day, periods: count });
  }
  const [month, target] = [...months].sort((a, b) => b[1].count - a[1].count)[0];
  const start = fixture.rangeStart + target.day * dayMs;
  await page.getByLabel('回看日期', { exact: true }).fill(target.date);
  await page.waitForFunction(count => globalThis.document.querySelectorAll('.period-list > div').length === count, target.periods);
  await painted(page);
  for (let attempts = 0; attempts < 16 && await page.locator('.zoom-label').textContent() !== '24小时0分'; attempts++) {
    await page.getByRole('button', { name: '缩小', exact: true }).click();
    await painted(page);
  }
  assert.equal(await page.locator('.zoom-label').textContent(), '24小时0分');
  const cursorTimes = [], navigationTimes = [], monthTimes = [], dayTimes = [];
  const image = page.locator('.evidence-image-area img');
  for (let index = 0; index < 100; index++) {
    progress = `cursor ${index}`;
    const period = index * 97 % target.periods, observation = start + (period * 10 + 5) * fixture.stepMs;
    const cursorTs = observation + fixture.stepMs / 2;
    const slider = page.getByLabel('回看时间游标', { exact: true });
    const bounds = await slider.evaluate(element => ({ min: Number(element.min), max: Number(element.max) }));
    const begin = performance.now();
    if (cursorTs < bounds.min || cursorTs > bounds.max) {
      await slider.press(cursorTs < bounds.min ? 'Home' : 'End');
      await page.waitForFunction(ts => {
        const element = globalThis.document.querySelector('.timeline-slider');
        return element instanceof globalThis.HTMLInputElement && Number(element.min) <= ts && ts <= Number(element.max);
      }, cursorTs);
    }
    await slider.fill(String(cursorTs));
    await page.waitForFunction(({ label, width, height }) => {
      const element = globalThis.document.querySelector('.evidence-image-area img');
      return element instanceof globalThis.HTMLImageElement && element.alt.includes(label) && element.complete && element.naturalWidth === width && element.naturalHeight === height;
    }, { label: time(observation), width: fixture.width, height: fixture.height });
    await image.evaluate(element => element.decode());
    await painted(page);
    cursorTimes.push(performance.now() - begin);
    assert.equal(await page.locator('.cursor-identity time').textContent(), time(cursorTs));
  }
  await page.screenshot({ path: join(artifacts, 'renderer-benchmark-day.png'), fullPage: true });
  for (let index = 0; index < 10; index++) {
    progress = `day/month ${index}`;
    let begin = performance.now();
    await page.getByRole('button', { name: '缩小', exact: true }).click();
    await page.waitForFunction(count => globalThis.document.querySelector('.month-heading .subtle-text')?.textContent === `${count} 个片段`, target.count);
    await painted(page);
    monthTimes.push(performance.now() - begin); navigationTimes.push(monthTimes.at(-1));
    if (index === 0) await page.screenshot({ path: join(artifacts, 'renderer-benchmark-month.png'), fullPage: true });
    begin = performance.now();
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await image.waitFor();
    await image.evaluate(element => element.decode());
    await painted(page);
    dayTimes.push(performance.now() - begin); navigationTimes.push(dayTimes.at(-1));
  }
  progress = 'late month entry';
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  await page.waitForFunction(count => globalThis.document.querySelector('.month-heading .subtle-text')?.textContent === `${count} 个片段`, target.count);
  await painted(page);
  const lastPeriodStart = start + (target.periods - 1) * 10 * fixture.stepMs;
  const entries = page.getByLabel(`${target.date} 时序活动`, { exact: true });
  await entries.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const lastEntry = entries.getByRole('button').filter({ has: page.getByText(`${time(lastPeriodStart)} – ${time(lastPeriodStart + 10 * fixture.stepMs)}`, { exact: true }) });
  await lastEntry.waitFor();
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page.waitForFunction(count => globalThis.document.querySelector('.month-heading .subtle-text')?.textContent === `${count} 个片段`, target.count);
  await painted(page);
  await page.waitForFunction(date => {
    const container = globalThis.document.querySelector(`[aria-label="${date} 时序活动"]`);
    if (!container) return false;
    const viewport = container.getBoundingClientRect();
    return [...container.querySelectorAll('button')].some(button => {
      const bounds = button.getBoundingClientRect();
      return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    });
  }, target.date);
  await entries.evaluate(element => { element.scrollTop = 0; });
  await entries.getByRole('button').filter({ has: page.getByText(`${time(start)} – ${time(start + 10 * fixture.stepMs)}`, { exact: true }) }).waitFor();
  await entries.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await lastEntry.click();
  await page.waitForFunction(label => {
    const element = globalThis.document.querySelector('.evidence-image-area img');
    return element instanceof globalThis.HTMLImageElement && element.alt.includes(label) && element.complete && element.naturalWidth > 0;
  }, time(lastPeriodStart));
  assert.equal(await page.locator('.cursor-identity time').textContent(), time(lastPeriodStart));
  await page.setViewportSize({ width: 390, height: 844 });
  await painted(page);
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  assert.equal(await page.locator('.time-ruler > .ruler-current').isVisible(), true, 'Narrow ruler must show the current cursor time.');
  await page.screenshot({ path: join(artifacts, 'renderer-benchmark-day-narrow.png'), fullPage: true });
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  await page.waitForFunction(count => globalThis.document.querySelector('.month-heading .subtle-text')?.textContent === `${count} 个片段`, target.count);
  await painted(page);
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  await page.screenshot({ path: join(artifacts, 'renderer-benchmark-month-narrow.png'), fullPage: true });
  assert.deepEqual(pageErrors, []);
  const processMetrics = await application.evaluate(({ app }) => app.getAppMetrics().map(metric => ({
    type: metric.type, cpuPercent: metric.cpu.percentCPUUsage, workingSetKiB: metric.memory.workingSetSize, peakWorkingSetKiB: metric.memory.peakWorkingSetSize,
  })));
  const result = {
    measuredAt: new Date().toISOString(), status: percentile(cursorTimes, 0.95) <= 1_000 && percentile(navigationTimes, 0.95) <= 2_000 ? 'passed' : 'failed',
    scope: 'Production Electron main/preload/SQLite/rendered UI, cursor viewport positioning when required, controlled 1280x720 PNG protocol read/decode, completion of the 320ms day/month plane transition and two RAFs; synthetic data, no physical gestures or native capture.',
    cache: 'Fresh worker after seed; OS cache not flushed. Repeated navigation may use revision-checked metadata, SQLite, OS and Chromium image caches. No concurrent capture/model calls.',
    machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), osRelease: release() },
    fixture: { ...fixture, selectedDate: target.date, renderedMonth: month, renderedMonthPeriods: target.count },
    desktopViewport: { width: 1440, height: 1000 }, narrowViewport: { width: 390, height: 844 },
    cursor: stats(cursorTimes), dayAndMonth: stats(navigationTimes), month: stats(monthTimes), day: stats(dayTimes),
    processMetrics, thresholds: { cursorP95Ms: 1_000, dayAndMonthP95Ms: 2_000 }, narrowOverflow: false,
    lateMonthEntry: { date: target.date, index: target.periods - 1, cursorTs: lastPeriodStart, exactJump: true, refreshed: true }, pageErrors,
    power: 'Not measured; CPU and memory are a final point-in-time snapshot, not average load or battery usage.',
  };
  await writeFile(join(artifacts, 'renderer-benchmark.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  assert.ok(percentile(cursorTimes, 0.95) <= 1_000, 'Rendered cursor/image p95 must be at most 1 second.');
  assert.ok(percentile(navigationTimes, 0.95) <= 2_000, 'Rendered day/month p95 must be at most 2 seconds.');
}

try { await run(); }
catch (error) {
  const page = application?.windows()[0];
  if (page) {
    console.error(JSON.stringify({ progress, pageErrors, state: await page.evaluate(() => ({
      cursor: globalThis.document.querySelector('.cursor-identity')?.textContent,
      image: [...globalThis.document.querySelectorAll('.evidence-image-area img')].map(element => ({ alt: element.alt, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight })),
      text: globalThis.document.body.innerText.slice(0, 2_000),
    })) }));
    await page.screenshot({ path: join(artifacts, 'renderer-benchmark-failure.png'), fullPage: true });
  }
  throw error;
}
finally {
  if (application) {
    const child = application.process();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try { await application.close(); }
    finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  }
  await rm(directory, { recursive: true, force: true });
}
