import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexAdapter, CodexJsonlReader, codexArguments, type CodexProcessLauncher } from '../../src/services/agents/codex'
import { detectCodex, minimalEnvironment, type CodexDetection } from '../../src/services/agents/capability-check'
import { AGENT_KILL_GRACE_MS, AGENT_TIMEOUT_MS, MAX_AGENT_INPUT_BYTES, MAX_AGENT_LINE_BYTES, ProposalSchema, sha256, validateProposal, type IsolationEvidence, type ProposalBinding } from '../../src/services/agents/types'

const directories: string[] = []
const adapters: CodexAdapter[] = []
afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const inputSnapshot = Buffer.from('Synthetic approved facts only. 中文。')
function binding(): ProposalBinding {
  return { runId: randomUUID(), generation: 1, skillVersionId: randomUUID(), inputSnapshotHash: sha256(inputSnapshot), targetSnapshotHash: sha256('synthetic target'), sectionRef: 'section:2099-01-01:synthetic', sourceRefs: [randomUUID()] }
}
const replacementMarkdown = '## 2099-01-01\n\n- 合成验证。\n'
const proposal = (frozen: ProposalBinding) => ({ ...frozen, replacementMarkdown })
function stream(frozen: ProposalBinding, value: unknown = proposal(frozen)): Buffer {
  return Buffer.from([
    { type: 'thread.started', thread_id: 'synthetic' },
    { type: 'item.completed', item: { id: 'reasoning', type: 'reasoning', text: 'Synthetic reasoning is not a proposal.' } },
    { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: JSON.stringify(value) } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ].map((value) => JSON.stringify(value)).join('\n') + '\n')
}

const fixtureScript = (mode: string): string => `
const mode = ${JSON.stringify(mode)};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const binding = JSON.parse(input.split('\\n').find(line => line.startsWith('Frozen binding: ')).slice('Frozen binding: '.length));
  process.stdout.write(JSON.stringify({type:'thread.started', thread_id:'synthetic'}) + '\\n');
  if (mode === 'ignore-term') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
  if (mode === 'tool') { process.stdout.write(JSON.stringify({type:'item.started', item:{type:'mcp_tool_call'}}) + '\\n'); setInterval(() => {}, 1000); return; }
  if (mode === 'stderr') { process.stderr.write(Buffer.alloc(1024*1024+1, 120)); setInterval(() => {}, 1000); return; }
  setTimeout(() => {
    const result = {...binding, replacementMarkdown: '## 2099-01-01\\n\\n- 合成验证。\\n'};
    process.stdout.write(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:JSON.stringify(result)}}) + '\\n');
    process.stdout.write(JSON.stringify({type:'turn.completed'}) + '\\n');
  }, 80);
});
`

async function fixture(options: { isolated?: boolean; configuration?: { value: string } } = {}) {
  const runRoot = await mkdtemp(path.join(tmpdir(), 'one-room-codex-test-'))
  directories.push(runRoot)
  let mode = 'valid'
  let startedResolve: (() => void) | undefined
  const launches: { binary: string; argv: string[]; environment: NodeJS.ProcessEnv; stdin: string; schema?: unknown }[] = []
  const configuration = options.configuration || { value: sha256('isolated synthetic host') }
  const detection: CodexDetection = { binaryPath: process.execPath, environment: minimalEnvironment({}, path.dirname(process.execPath)), version: '0.144.1', authState: 'ready', supportedArguments: true, fingerprint: sha256('fixture binary') }
  const launch: CodexProcessLauncher = (binary, argv, launchOptions) => {
    const captured = { binary, argv, environment: launchOptions.env || {}, stdin: '', schema: undefined as unknown }
    launches.push(captured)
    const child = spawn(process.execPath, ['-e', fixtureScript(mode), '--', ...argv], { ...launchOptions, env: { ...launchOptions.env, ELECTRON_RUN_AS_NODE: '1' } })
    const originalWrite = child.stdin.write.bind(child.stdin)
    child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.stdin += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      return Reflect.apply(originalWrite, child.stdin, [chunk, ...rest])
    }) as typeof child.stdin.write
    const originalEnd = child.stdin.end.bind(child.stdin)
    child.stdin.end = ((chunk: unknown, ...rest: unknown[]) => {
      if (chunk !== undefined) captured.stdin += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      return Reflect.apply(originalEnd, child.stdin, [chunk, ...rest])
    }) as typeof child.stdin.end
    child.stdout.once('data', () => startedResolve?.())
    void readFile(argv[argv.indexOf('--output-schema') + 1], 'utf8').then((text) => { captured.schema = JSON.parse(text) }).catch(() => undefined)
    return child
  }
  const evidence = (): IsolationEvidence => ({ manifestVersion: 1, configurationHash: configuration.value, readOnlyEnforced: true, externalToolStartupPrevented: true, processTreeObserved: true })
  const adapter = new CodexAdapter({ runRoot, detect: async () => ({ ...detection }), launch, ...(options.isolated === false ? {} : { isolationVerifier: async () => evidence() }) })
  adapters.push(adapter)
  return { adapter, launches, detection, configuration, mode: (value: string) => { mode = value }, started: () => new Promise<void>((resolve) => { startedResolve = resolve }) }
}

describe('Codex frozen proposal protocol', () => {
  it('matches the strict machine schema and canonical binding without retaining reasoning', async () => {
    const frozen = binding()
    const reader = new CodexJsonlReader(frozen)
    const bytes = stream(frozen)
    // Deliberately split every UTF-8 code point across pipe chunks.
    for (let index = 0; index < bytes.length; index += 1) reader.feed(bytes.subarray(index, index + 1))
    const result = reader.finish(0)
    expect(result.proposal).toEqual(proposal(frozen))
    expect(result.proposalHash).toBe(sha256(result.canonicalBytes))
    expect(result.canonicalBytes.toString()).not.toContain('reasoning')
    const schema = JSON.parse(await readFile(path.join(process.cwd(), 'specs/001-event-driven-capture/contracts/proposal.schema.json'), 'utf8'))
    expect(Object.keys(ProposalSchema.shape)).toEqual(schema.required)
    expect(Object.keys(JSON.parse(result.canonicalBytes.toString()))).toEqual(schema.required)
  })

  it('rejects extra fields, wrong bindings, invented/duplicate sources, and UTF-8 oversized replacement', () => {
    const frozen = binding()
    for (const bad of [
      { ...proposal(frozen), extra: true }, { ...proposal(frozen), generation: 2 },
      { ...proposal(frozen), targetSnapshotHash: sha256('other') }, { ...proposal(frozen), sourceRefs: [randomUUID()] },
      { ...proposal(frozen), sourceRefs: [...frozen.sourceRefs, ...frozen.sourceRefs] },
      { ...proposal(frozen), replacementMarkdown: '中'.repeat(Math.ceil(MAX_AGENT_INPUT_BYTES / 3)) },
    ]) expect(() => validateProposal(bad, frozen)).toThrowError(expect.objectContaining({ error: expect.objectContaining({ detailCode: 'INVALID_AGENT_OUTPUT' }) }))
  })

  it('requires one final message, successful turn, complete JSONL, valid UTF-8, and normal exit together', () => {
    const frozen = binding()
    const valid = stream(frozen).toString()
    const final = `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(proposal(frozen)) } })}\n`
    const cases = [
      valid.trimEnd(), valid.replace(/.*turn.completed.*\n/, ''),
      valid.replace(/.*agent_message.*\n/, ''), final + valid,
      valid + `${JSON.stringify({ type: 'turn.failed' })}\n`, '{bad json}\n',
    ]
    for (const output of cases) {
      const reader = new CodexJsonlReader(frozen)
      expect(() => { reader.feed(Buffer.from(output)); reader.finish(0) }).toThrow()
    }
    for (const exitCode of [1, null]) {
      const reader = new CodexJsonlReader(frozen)
      reader.feed(stream(frozen))
      expect(() => reader.finish(exitCode)).toThrow()
    }
    const reader = new CodexJsonlReader(frozen)
    expect(() => reader.feed(Buffer.from([0xc3, 0x28, 10]))).toThrow()
  })

  it('rejects all tool activity and bounds individual lines and total stdout', () => {
    const frozen = binding()
    for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'unknown_external_tool']) {
      expect(() => new CodexJsonlReader(frozen).feed(Buffer.from(`${JSON.stringify({ type: 'item.started', item: { type } })}\n`))).toThrowError(expect.objectContaining({ error: expect.objectContaining({ detailCode: 'EXTERNAL_TOOL_STARTED' }) }))
    }
    expect(() => new CodexJsonlReader(frozen).feed(Buffer.from(`${JSON.stringify({ type: 'mcp.server.started' })}\n`))).toThrow()
    expect(() => new CodexJsonlReader(frozen).feed(Buffer.alloc(MAX_AGENT_LINE_BYTES + 1, 32))).toThrow()
    const reader = new CodexJsonlReader(frozen)
    const metadata = Buffer.from(`${JSON.stringify({ type: 'synthetic.metadata', padding: ' '.repeat(MAX_AGENT_LINE_BYTES - 100) })}\n`)
    expect(() => { for (let index = 0; index < 5; index += 1) reader.feed(metadata) }).toThrow()
  })

  it('fails closed before business stdin when startup isolation or capability evidence is absent', async () => {
    const host = await fixture({ isolated: false })
    expect(await host.adapter.checkCapability()).toMatchObject({ state: 'capability_blocked', detailCode: 'STARTUP_ISOLATION_UNPROVEN' })
    await expect(host.adapter.propose({ binding: binding(), inputSnapshot })).rejects.toMatchObject({ error: { code: 'CAPABILITY_BLOCKED' } })
    expect(host.launches).toHaveLength(0)
    const status = await host.adapter.detect()
    expect(status[0]).toMatchObject({ installed: true, authenticated: true, enabled: false, capabilityState: 'capability_blocked' })
    expect(status[1]).toMatchObject({ id: 'claude', capabilityState: 'disabled', enabled: false })
  })

  it('runs synthetic compatibility checks before a fixed-argv business proposal and invalidates changed configuration', async () => {
    const host = await fixture()
    const record = await host.adapter.checkCapability()
    expect(record.state).toBe('ready')
    expect(Object.values(record.checks).every(Boolean)).toBe(true)
    expect(host.launches).toHaveLength(3)
    expect(host.launches.every((value) => !value.stdin.includes(inputSnapshot.toString()))).toBe(true)
    const frozen = binding()
    const result = await host.adapter.propose({ binding: frozen, inputSnapshot })
    expect(result.proposal).toEqual(proposal(frozen))
    const last = host.launches.at(-1)!
    expect(last.argv).toEqual(codexArguments(last.argv[last.argv.indexOf('--cd') + 1], last.argv[last.argv.indexOf('--output-schema') + 1]))
    expect(last.argv).not.toContain(inputSnapshot.toString())
    expect(last.stdin).toContain(inputSnapshot.toString())
    expect(last.environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(last.schema).toMatchObject({ additionalProperties: false, required: Object.keys(ProposalSchema.shape) })
    host.configuration.value = sha256('changed configuration')
    await expect(host.adapter.propose({ binding: binding(), inputSnapshot })).rejects.toMatchObject({ error: { code: 'CAPABILITY_BLOCKED', detailCode: 'CAPABILITY_CHECK_REQUIRED' } })
    expect(host.launches).toHaveLength(4)
    expect((await host.adapter.detect())[0].enabled).toBe(false)
  })

  it('rejects frozen-byte changes and stale generations without creating business processes', async () => {
    const host = await fixture()
    await expect(host.adapter.propose({ binding: binding(), inputSnapshot: Buffer.from('changed') })).rejects.toMatchObject({ error: { detailCode: 'INPUT_CHANGED' } })
    await expect(host.adapter.propose({ binding: binding(), inputSnapshot, isCurrent: () => false })).rejects.toMatchObject({ error: { detailCode: 'GENERATION_MISMATCH' } })
    await expect(host.adapter.propose({ binding: binding(), inputSnapshot: Buffer.alloc(MAX_AGENT_INPUT_BYTES + 1) })).rejects.toMatchObject({ error: { detailCode: 'INPUT_TOO_LARGE' } })
    expect(host.launches).toHaveLength(0)
  })

  it('blocks unsupported versions/arguments and missing authentication before any synthetic or business launch', async () => {
    const host = await fixture()
    host.detection.version = '0.145.0'
    expect(await host.adapter.checkCapability()).toMatchObject({ state: 'capability_blocked', detailCode: 'AGENT_VERSION_UNSUPPORTED' })
    host.detection.version = '0.144.1'
    host.detection.supportedArguments = false
    expect(await host.adapter.checkCapability()).toMatchObject({ state: 'capability_blocked', detailCode: 'AGENT_ARGUMENTS_UNSUPPORTED' })
    host.detection.supportedArguments = true
    host.detection.authState = 'missing'
    await expect(host.adapter.propose({ binding: binding(), inputSnapshot })).rejects.toMatchObject({ error: { code: 'AUTH_REQUIRED' } })
    expect(await host.adapter.checkCapability()).toMatchObject({ state: 'capability_blocked', detailCode: 'AGENT_AUTH_REQUIRED' })
    expect(host.launches).toHaveLength(0)
  })

  it('stops a violating process and rejects a late result from an invalidated generation', async () => {
    const host = await fixture()
    expect((await host.adapter.checkCapability()).state).toBe('ready')
    host.mode('tool')
    await expect(host.adapter.propose({ binding: binding(), inputSnapshot })).rejects.toMatchObject({ error: { detailCode: 'EXTERNAL_TOOL_STARTED' } })
    expect((await host.adapter.detect())[0]).toMatchObject({ capabilityState: 'capability_blocked', enabled: false, detailCode: 'EXTERNAL_TOOL_STARTED' })
    host.mode('valid')
    expect((await host.adapter.checkCapability()).state).toBe('ready')
    host.mode('stderr')
    await expect(host.adapter.propose({ binding: binding(), inputSnapshot })).rejects.toMatchObject({ error: { detailCode: 'INVALID_AGENT_OUTPUT' } })
    host.mode('valid')
    let checks = 0
    await expect(host.adapter.propose({ binding: binding(), inputSnapshot, isCurrent: () => ++checks < 3 })).rejects.toMatchObject({ error: { detailCode: 'GENERATION_MISMATCH' } })
  })

  it('cancels only the requested generation and kills a SIGTERM-resistant process group', async () => {
    const host = await fixture()
    expect((await host.adapter.checkCapability()).state).toBe('ready')
    expect(AGENT_TIMEOUT_MS).toBe(120_000)
    expect(AGENT_KILL_GRACE_MS).toBe(2_000)
    host.mode('ignore-term')
    const started = host.started()
    const frozen = binding()
    const pending = host.adapter.propose({ binding: frozen, inputSnapshot }).catch((error: unknown) => error)
    await started
    host.adapter.cancel(frozen.runId, frozen.generation + 1)
    host.adapter.cancel(frozen.runId, frozen.generation)
    host.adapter.cancel(frozen.runId, frozen.generation)
    expect(await pending).toMatchObject({ error: { code: 'CANCELED' } })
  }, 10_000)

  it('uses local readonly detection and a small environment without inheriting runtime injection or model credentials', async () => {
    const status = await detectCodex({ binaryPath: path.join(tmpdir(), `not-installed-${randomUUID()}`) })
    expect(status).toMatchObject({ binaryPath: null, detailCode: 'AGENT_NOT_INSTALLED' })
    const environment = minimalEnvironment({ OPENAI_API_KEY: 'never expose', NODE_OPTIONS: '--require injected', CODEX_HOME: '/synthetic/auth', PATH: '/untrusted' }, '/approved/bin')
    expect(environment.CODEX_HOME).toBe('/synthetic/auth')
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
    expect(environment.PATH).not.toContain('/untrusted')
  })
})
