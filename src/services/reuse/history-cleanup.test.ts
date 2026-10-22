import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REUSE_SCHEMA_V1 } from './schema-v1'
import { cleanupReuseRunFiles, scrubReuseSources } from './history-cleanup'

let db: Database.Database
const directories: string[] = []
beforeEach(() => {
  db = new Database(':memory:')
  db.exec(REUSE_SCHEMA_V1)
})
afterEach(() => {
  db.close()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

it('删除来源时保护运行中的流程，结束后连同持久来源引用一起清理', () => {
  const source = randomUUID(), skill = randomUUID(), run = randomUUID()
  db.prepare('INSERT INTO or_skills VALUES (?,?,?,?)').run(skill, 1, 0, JSON.stringify({ sourceObservationIds: [source] }))
  db.prepare('INSERT INTO or_runs VALUES (?,?,?,?,?,?,?,?,?,?)').run(run, skill, 1, 'http://localhost/', 'applying', 0, 0, '', '', '')
  expect(scrubReuseSources(db, [randomUUID()])).toEqual([])
  expect(() => db.transaction(() => scrubReuseSources(db, [source]))()).toThrow('相关流程仍在执行')
  expect(db.prepare('SELECT count(*) AS n FROM or_skills').get()).toEqual({ n: 1 })
  expect(db.prepare('SELECT count(*) AS n FROM or_runs').get()).toEqual({ n: 1 })
  db.prepare("UPDATE or_runs SET state='needs_verification' WHERE id=?").run(run)
  expect(scrubReuseSources(db, [source])).toEqual([run])
  expect(db.prepare('SELECT count(*) AS n FROM or_skills').get()).toEqual({ n: 0 })
  expect(db.prepare('SELECT count(*) AS n FROM or_runs').get()).toEqual({ n: 0 })
})

it('删除运行文件同时覆盖旧目录和本机流程目录，不影响其他记录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-room-run-cleanup-'))
  directories.push(root)
  const run = randomUUID(), retained = randomUUID()
  for (const relative of [run, path.join('workflows', 'runs', run), path.join('workflows', 'runs', retained)]) {
    fs.mkdirSync(path.join(root, relative), { recursive: true })
    fs.writeFileSync(path.join(root, relative, 'receipt.json'), '{}')
  }
  await cleanupReuseRunFiles(root, [run])
  expect(fs.existsSync(path.join(root, run))).toBe(false)
  expect(fs.existsSync(path.join(root, 'workflows', 'runs', run))).toBe(false)
  expect(fs.existsSync(path.join(root, 'workflows', 'runs', retained, 'receipt.json'))).toBe(true)
  await expect(cleanupReuseRunFiles(root, ['../outside'])).rejects.toThrow('Invalid agent run cleanup identity')
})
