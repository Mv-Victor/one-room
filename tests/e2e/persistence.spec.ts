import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dateKey, dayBounds } from '../../src/shared/time';

test('production report UI and deletion bridge persist across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'one-room-persistence-e2e-'));
  const launch = () => electron.launch({ args: [process.cwd()], env: { ...process.env, ONE_ROOM_USER_DATA: root } });
  let application = await launch();
  const key = dateKey(Date.now()), range = dayBounds(key), errors: string[] = [];
  try {
    let page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByText('本地已连接')).toBeVisible();
    await page.getByRole('button', { name: '报告', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('暂无报告');
    await page.getByRole('button', { name: '生成事实报告', exact: true }).click();
    await expect(page.getByText('此范围没有记录', { exact: true })).toBeVisible();
    const before = await page.evaluate(key => window.oneRoom!.report!.get({ kind: 'daily', dateKey: key }), key);
    expect(before.ok && before.data.status).toBe('ready');
    const reportId = before.ok ? before.data.report!.id : '';
    await application.close(); application = await launch();
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByText('本地已连接')).toBeVisible();
    await page.getByRole('button', { name: '报告', exact: true }).click();
    await expect(page.getByText('此范围没有记录', { exact: true })).toBeVisible();
    const persisted = await page.evaluate(key => window.oneRoom!.report!.get({ kind: 'daily', dateKey: key }), key);
    expect(persisted.ok && persisted.data.report?.id).toBe(reportId);
    const preview = await page.evaluate(range => window.oneRoom!.history!.previewDelete(range), range);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error('Deletion preview failed.');
    expect(preview.data.observationCount).toBe(0);
    const request = { deletionRef: preview.data.deletionRef, expectedRevision: preview.data.dataRevision, confirmed: true as const, idempotencyKey: crypto.randomUUID() };
    const deleted = await page.evaluate(input => window.oneRoom!.history!.delete(input), request);
    expect(deleted.ok && deleted.data.cleanup).toBe('complete');
    const retried = await page.evaluate(input => window.oneRoom!.history!.delete(input), request);
    expect(retried.ok && retried.data).toEqual(deleted.ok && deleted.data);
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
