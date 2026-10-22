import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { CODEX_VERSION, sha256, type AgentCapabilityStatus, type CapabilityRecord } from './types'

export interface CodexDetection {
  binaryPath: string | null
  environment: NodeJS.ProcessEnv
  version: string | null
  authState: 'ready' | 'missing' | 'unknown'
  supportedArguments: boolean
  fingerprint: string
  detailCode?: string
}

export interface DetectionOptions {
  binaryPath?: string
  environment?: NodeJS.ProcessEnv
}

export function minimalEnvironment(source: NodeJS.ProcessEnv, binaryDirectory: string): NodeJS.ProcessEnv {
  const home = homedir()
  return {
    HOME: home,
    USER: source.USER || path.basename(home),
    LOGNAME: source.LOGNAME || source.USER || path.basename(home),
    PATH: [...new Set([binaryDirectory, path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(path.delimiter),
    TMPDIR: tmpdir(),
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    CODEX_HOME: source.CODEX_HOME && path.isAbsolute(source.CODEX_HOME) ? source.CODEX_HOME : path.join(home, '.codex'),
  }
}

async function resolveBinary(options: DetectionOptions): Promise<{ binaryPath: string; directory: string } | null> {
  const source = options.environment || process.env
  if (options.binaryPath && !path.isAbsolute(options.binaryPath)) return null
  const directories = [
    ...(source.PATH || '').split(path.delimiter),
    ...['.local/bin', '.bun/bin', '.volta/bin', '.npm-global/bin'].map((value) => path.join(homedir(), value)),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ]
  if (!options.binaryPath) {
    const nvm = path.join(homedir(), '.nvm/versions/node')
    try {
      const versions = await readdir(nvm, { withFileTypes: true })
      directories.push(...versions.filter((entry) => entry.isDirectory()).slice(0, 64).map((entry) => path.join(nvm, entry.name, 'bin')))
    } catch { /* NVM is optional; no interactive shell or installation is needed. */ }
  }
  const candidates = options.binaryPath ? [options.binaryPath] : [...new Set(directories.filter((directory) => path.isAbsolute(directory)))].map((directory) => path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex'))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      let binaryPath = await realpath(candidate)
      if (path.extname(binaryPath) === '.js') {
        // Invoke and fingerprint the official native payload directly, so an npm
        // wrapper's unchanged bytes cannot hide a replaced runtime executable.
        const packageRoot = path.dirname(path.dirname(binaryPath))
        const manifestPath = path.join(packageRoot, 'package.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: string }
        if (manifest.name !== '@openai/codex') continue
        const triples: Record<string, string> = {
          'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
          'linux-arm64': 'aarch64-unknown-linux-musl', 'linux-x64': 'x86_64-unknown-linux-musl',
          'win32-arm64': 'aarch64-pc-windows-msvc', 'win32-x64': 'x86_64-pc-windows-msvc',
        }
        const triple = triples[`${process.platform}-${process.arch}`]
        if (!triple) continue
        let vendorRoot = path.join(packageRoot, 'vendor')
        try {
          const nativeManifest = createRequire(manifestPath).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`)
          vendorRoot = path.join(path.dirname(nativeManifest), 'vendor')
        } catch { /* Older official packages use a bundled vendor directory. */ }
        binaryPath = await realpath(path.join(vendorRoot, triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'))
        await access(binaryPath, constants.X_OK)
      }
      if (!(await stat(binaryPath)).isFile()) continue
      return { binaryPath, directory: path.dirname(candidate) }
    } catch { /* Continue through fixed local lookup locations. */ }
  }
  return null
}

function probe(binary: string, argv: string[], environment: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(binary, argv, { env: environment, shell: false, timeout: 3_000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, code: error ? typeof error.code === 'number' ? error.code : null : 0 })
    })
  })
}

async function binaryHash(binary: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(binary)) hash.update(chunk)
  return hash.digest('hex')
}

export async function detectCodex(options: DetectionOptions = {}): Promise<CodexDetection> {
  const resolved = await resolveBinary(options)
  const environment = minimalEnvironment(options.environment || process.env, resolved?.directory || '/usr/bin')
  const unavailable: CodexDetection = { binaryPath: null, environment, version: null, authState: 'unknown', supportedArguments: false, fingerprint: '', detailCode: 'AGENT_NOT_INSTALLED' }
  if (!resolved) return unavailable
  const version = await probe(resolved.binaryPath, ['--version'], environment)
  const match = version.code === 0 ? /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)\s*$/.exec(version.stdout.trim()) : null
  if (!match) return { ...unavailable, binaryPath: resolved.binaryPath, detailCode: 'AGENT_VERSION_UNSUPPORTED' }
  const detected: CodexDetection = { ...unavailable, binaryPath: resolved.binaryPath, version: match[1], detailCode: undefined }
  if (detected.version !== CODEX_VERSION) return { ...detected, detailCode: 'AGENT_VERSION_UNSUPPORTED' }
  const help = await probe(resolved.binaryPath, ['exec', '--help'], environment)
  detected.supportedArguments = help.code === 0 && ['--json', '--output-schema', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', '--skip-git-repo-check', '--cd'].every((flag) => help.stdout.includes(flag))
  if (!detected.supportedArguments) return { ...detected, detailCode: 'AGENT_ARGUMENTS_UNSUPPORTED' }
  const authentication = await probe(resolved.binaryPath, ['login', 'status'], environment)
  const status = `${authentication.stdout}\n${authentication.stderr}`
  detected.authState = authentication.code === 0 && /logged in/i.test(status) ? 'ready' : /not logged in|not authenticated|no auth|please log in/i.test(status) ? 'missing' : 'unknown'
  // No auth file is opened. The host's isolation evidence supplies the effective
  // configuration hash; these bytes bind that evidence to this exact executable.
  try {
    detected.fingerprint = sha256(JSON.stringify({ binary: await binaryHash(resolved.binaryPath), binaryPath: resolved.binaryPath, version: detected.version, platform: process.platform, arch: process.arch, environment }))
  } catch {
    detected.detailCode = 'AGENT_BINARY_CHANGED'
  }
  return detected
}

export function capabilityStatuses(detection: CodexDetection, capability?: CapabilityRecord): AgentCapabilityStatus[] {
  const ready = detection.authState === 'ready' && detection.version === CODEX_VERSION && detection.supportedArguments && capability?.state === 'ready'
  const detailCode = detection.detailCode || (detection.authState !== 'ready' ? 'AGENT_AUTH_REQUIRED' : capability?.detailCode)
  return [{
    id: 'codex', installed: detection.binaryPath !== null, authenticated: detection.authState === 'ready', authState: detection.authState,
    enabled: ready, version: detection.version, capabilityState: ready ? 'ready' : capability?.state === 'capability_blocked' || detection.detailCode ? 'capability_blocked' : 'unverified',
    detail: ready ? 'Codex 能力验证通过。' : detection.detailCode === 'AGENT_NOT_INSTALLED' ? '未找到本机 Codex CLI。' : detection.version !== CODEX_VERSION ? '当前 Codex 版本尚未通过兼容验证。' : detection.authState === 'missing' ? '请先在终端登录 Codex。' : detection.authState === 'unknown' ? 'Codex 认证状态待验证。' : capability?.state === 'capability_blocked' ? 'Codex 隔离能力未通过，尚未发送业务内容。' : '已检测到 Codex，请先执行合成能力验证。',
    ...(detailCode ? { detailCode } : {}),
  }, {
    id: 'claude', installed: false, authenticated: false, authState: 'unknown', enabled: false, version: null, capabilityState: 'disabled', detail: '暂未接入', detailCode: 'PROVIDER_DISABLED',
  }]
}
