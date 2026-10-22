import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { NativeCommandSchema, NativeEventSchema, NativeHelloPayloadSchema, NativeResultSchema, type NativeCommand, type NativeEvent, type NativeResult } from '../../shared/schemas';

export class NativeSession {
  readonly id = randomUUID();
  private process: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { command: NativeCommand; resolve(value: NativeResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private bytes = Buffer.alloc(0);
  private closed = false;
  private sequence = 0;
  private observationRequestId: string | null = null;
  onEvent?: (event: NativeEvent) => void;
  onFailure?: () => void;

  constructor(binary: string, readonly generation: number) {
    this.process = spawn(binary, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.process.stdout.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      this.bytes = Buffer.concat([this.bytes, chunk]);
      try {
        let end: number;
        while ((end = this.bytes.indexOf(10)) >= 0) {
          if (end > 1048576) throw new Error('Native message budget exceeded.');
          const line = this.bytes.subarray(0, end); this.bytes = this.bytes.subarray(end + 1);
          if (!line.length) continue;
          const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
          const parsedEvent = NativeEventSchema.safeParse(raw);
          if (parsedEvent.success) {
            const event = parsedEvent.data;
            if (event.helperSessionId !== this.id || event.generation !== this.generation || event.requestId !== this.observationRequestId || event.sequence <= this.sequence) throw new Error('Native event identity mismatch.');
            this.sequence = event.sequence; this.onEvent?.(event); continue;
          }
          const result = NativeResultSchema.parse(raw), job = result.requestId ? this.pending.get(result.requestId) : undefined;
          if (!job || result.helperSessionId !== this.id || result.generation !== this.generation || result.method !== job.command.method || result.pid !== job.command.pid || result.windowId !== job.command.windowId || result.observationId !== job.command.observationId) throw new Error('Native result identity mismatch.');
          if (result.status === 'accepted') continue;
          this.pending.delete(job.command.requestId); clearTimeout(job.timer);
          if (result.status === 'ok' || result.status === 'partial') job.resolve(result);
          else job.reject(new Error(result.error?.code ?? 'NATIVE_FAILED'));
        }
        if (this.bytes.length > 1048576) throw new Error('Native message budget exceeded.');
      } catch { this.stop(); }
    });
    let diagnosticBytes = 0;
    this.process.stderr.on('data', (chunk: Buffer) => { diagnosticBytes += chunk.length; if (diagnosticBytes > 131072) this.stop(); });
    this.process.stdin.on('error', () => this.stop());
    this.process.on('error', () => this.stop());
    this.process.on('close', () => this.stop());
  }

  async hello(role: 'listener' | 'executor', stagingRoot: string) {
    const result = await this.request('hello', { role, stagingRoot });
    return NativeHelloPayloadSchema.parse(result.payload);
  }

  request(method: NativeCommand['method'], payload: object = {}, identity: { pid?: number; windowId?: number; observationId?: string } = {}, timeoutMs = 5000): Promise<NativeResult> {
    if (this.closed) return Promise.reject(new Error('Native helper disconnected.'));
    if (this.pending.size >= 16) return Promise.reject(new Error('Native pending request budget exceeded.'));
    const issuedAt = Date.now();
    const command = NativeCommandSchema.parse({ protocolVersion: 1, helperSessionId: this.id, kind: 'command', method, requestId: randomUUID(), generation: this.generation, observationId: identity.observationId ?? null, pid: identity.pid ?? null, windowId: identity.windowId ?? null, issuedAt, deadlineAt: issuedAt + timeoutMs, payload });
    const encoded = `${JSON.stringify(command)}\n`;
    if (Buffer.byteLength(encoded) > 1048576) return Promise.reject(new Error('Native command budget exceeded.'));
    if (method === 'observe') this.observationRequestId = command.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.stop(); }, timeoutMs);
      this.pending.set(command.requestId, { command, resolve, reject, timer });
      this.process.stdin.write(encoded);
    });
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.process.kill('SIGKILL');
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error('Native helper stopped or timed out.')); }
    this.pending.clear(); this.onFailure?.();
  }
}
