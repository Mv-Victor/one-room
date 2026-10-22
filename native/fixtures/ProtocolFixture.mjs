#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const command = JSON.parse(line);
  const response = { ...command, kind: 'result', startedAt: Date.now(), finishedAt: Date.now(), payload: {} };
  delete response.issuedAt; delete response.deadlineAt;
  if (command.method === 'frontmost') continue;
  if (command.method === 'status') {
    process.stdout.write(`${JSON.stringify({ ...response, status: 'accepted' })}\n`);
    setTimeout(() => process.stdout.write(`${JSON.stringify({ ...response, status: 'failed',
      error: { code: 'FIXTURE_TERMINAL', stage: 'fixture', retryable: false, requestId: command.requestId, generation: command.generation } })}\n`), 50);
  } else {
    process.stdout.write(`${JSON.stringify({ ...response, generation: command.generation + 1, status: 'failed',
      error: { code: 'FIXTURE_WRONG_GENERATION', stage: 'fixture', retryable: false, requestId: command.requestId, generation: command.generation + 1 } })}\n`);
  }
}
