// SPDX-License-Identifier: GPL-3.0-or-later
// Process spawn/stdin/error lifecycle adapted from MemoryLane v1.5.10,
// native-screenshot.ts L123-172, commit f3157d54524e647d32f7decd186ee00cac9f72d5.
// Changes: read-only hello, strict JSONL identities, bounded output and a hard timeout.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  NativeCommandSchema, NativeHelloPayloadSchema, NativePermissionRequestPayloadSchema, NativeResultSchema,
  PermissionsSchema, type PermissionKind, type Permissions
} from '../../shared/schemas'
import type { z } from 'zod'
import { NativeSession } from './native-session'
import { DomainError } from '../../shared/errors'

type NativeHelloPayload = z.infer<typeof NativeHelloPayloadSchema>
export interface NativeHelperInspection {
  permissions: Permissions
  capabilities: NativeHelloPayload['capabilities']
  helperVersion: string
}

const INSPECTION_TIMEOUT_MS = 5_000
const MAX_INSPECTION_OUTPUT_BYTES = 128 * 1024

export function inspectNativeHelper(binaryPath: string, responsibleProcess = 'one-room-helper'): Promise<NativeHelperInspection> {
  if (!isAbsolute(binaryPath)) return Promise.reject(new Error('Native helper path must be absolute.'))
  return new Promise((resolve, reject) => {
    const helperSessionId = randomUUID()
    const issuedAt = Date.now()
    const command = (method: 'hello' | 'shutdown') => NativeCommandSchema.parse({
      protocolVersion: 1, helperSessionId, kind: 'command', method, requestId: randomUUID(),
      generation: 1, observationId: null, pid: null, windowId: null,
      issuedAt, deadlineAt: issuedAt + INSPECTION_TIMEOUT_MS,
      payload: method === 'hello' ? { role: 'executor' } : {}
    })
    const hello = command('hello')
    const shutdown = command('shutdown')
    const proc = spawn(binaryPath, ['--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let finished = false
    let pending = Buffer.alloc(0)
    let outputBytes = 0
    let diagnosticBytes = 0
    let receivedShutdown = false
    let inspection: NativeHelperInspection | undefined
    const fail = (message: string) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      proc.kill('SIGKILL')
      reject(new Error(message))
    }
    const timer = setTimeout(() => fail('Native helper inspection timed out.'), INSPECTION_TIMEOUT_MS)

    const handleLine = (bytes: Buffer) => {
      const result = NativeResultSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
      const request = result.method === 'hello' ? hello : result.method === 'shutdown' ? shutdown : undefined
      if (!request || result.helperSessionId !== helperSessionId || result.requestId !== request.requestId ||
          result.generation !== request.generation || result.observationId !== null ||
          result.pid !== null || result.windowId !== null || result.status !== 'ok') {
        throw new Error('Unexpected native helper response.')
      }
      if (result.method === 'hello') {
        if (inspection) throw new Error('Duplicate native helper hello.')
        const payload = NativeHelloPayloadSchema.parse(result.payload)
        inspection = {
          helperVersion: payload.helperVersion,
          capabilities: payload.capabilities,
          permissions: PermissionsSchema.parse({
            ...Object.fromEntries((['screen', 'accessibility', 'inputMonitoring'] as const).map((kind) => [kind, {
              status: payload.permissions[kind], responsibleProcess,
              reason: payload.permissionReasons[kind]
            }])),
            checkedAt: result.finishedAt
          })
        }
        proc.stdin.end(`${JSON.stringify(shutdown)}\n`)
      } else {
        if (!inspection || receivedShutdown) throw new Error('Unexpected native helper shutdown.')
        receivedShutdown = true
      }
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      if (finished) return
      outputBytes += chunk.length
      if (outputBytes > MAX_INSPECTION_OUTPUT_BYTES) return fail('Native helper output exceeded the inspection budget.')
      pending = Buffer.concat([pending, chunk])
      try {
        let newline: number
        while ((newline = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, newline)
          pending = pending.subarray(newline + 1)
          if (line.length > 0) handleLine(line)
        }
      } catch {
        fail('Native helper returned an invalid handshake.')
      }
    })
    // Handle buffered writes after process exit so EPIPE cannot crash main.
    proc.stdin.on('error', () => fail('Native helper input pipe failed.'))
    proc.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length
      if (diagnosticBytes > MAX_INSPECTION_OUTPUT_BYTES) fail('Native helper diagnostics exceeded the inspection budget.')
    })
    proc.once('error', () => fail('Native helper could not start.'))
    proc.once('close', (code) => {
      if (finished) return
      if (code !== 0 || !inspection || !receivedShutdown || pending.length !== 0) {
        fail('Native helper exited before inspection completed.')
        return
      }
      finished = true
      clearTimeout(timer)
      resolve(inspection)
    })
    proc.stdin.write(`${JSON.stringify(hello)}\n`)
  })
}

export async function requestNativePermission(binaryPath: string, kind: PermissionKind): Promise<void> {
  const helper = new NativeSession(binaryPath, 1)
  try {
    const hello = NativeHelloPayloadSchema.parse((await helper.request('hello', { role: 'executor' })).payload)
    if (!hello.foundationMethods.includes('permissions.request')) {
      throw new DomainError('CAPABILITY_BLOCKED', '采集助手版本过旧，请重新构建并打开最新应用。', 'HELPER_UPDATE_REQUIRED')
    }
    const result = await helper.request('permissions.request', { kind }, {}, 60_000)
    const payload = NativePermissionRequestPayloadSchema.parse(result.payload)
    if (payload.kind !== kind) throw new Error('原生权限申请响应不匹配。')
  } finally {
    helper.stop()
  }
}
