import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, 'build/openadapt')
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('当前运行时打包仅支持 Apple Silicon Mac')
const uv = process.env.ONE_ROOM_UV || 'uv'
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options })
run(uv, ['python', 'install', '3.12'])
const python = execFileSync(uv, ['python', 'find', '--managed-python', '3.12'], {
  encoding: 'utf8',
}).trim()
const prefix = execFileSync(python, ['-c', 'import sys; print(sys.base_prefix)'], {
  encoding: 'utf8',
}).trim()
const stamp = path.join(target, 'runtime-version.json')
if (!fs.existsSync(stamp)) {
  fs.mkdirSync(target, { recursive: true })
  fs.cpSync(prefix, path.join(target, 'python'), { recursive: true, verbatimSymlinks: true })
  run(uv, [
    'pip',
    'install',
    '--python',
    python,
    '--target',
    path.join(target, 'site-packages'),
    '-r',
    path.join(root, 'resources/workflow/requirements.txt'),
  ])
  const env = {
    ...process.env,
    PYTHONHOME: path.join(target, 'python'),
    PYTHONPATH: path.join(target, 'site-packages'),
    PLAYWRIGHT_BROWSERS_PATH: path.join(target, 'browsers'),
  }
  run(path.join(target, 'python/bin/python3'), ['-m', 'playwright', 'install', 'chromium'], { env })
  fs.writeFileSync(
    stamp,
    JSON.stringify({
      engine: 'openadapt-flow',
      version: '2.0.0',
      python: '3.12',
      arch: process.arch,
    }),
  )
}
for (const file of ['workflow_bridge.py', 'workflow_replay.py', 'owned_browser.py'])
  fs.copyFileSync(path.join(root, 'resources/workflow', file), path.join(target, file))
console.log(`本地流程运行时已准备：${target}`)
