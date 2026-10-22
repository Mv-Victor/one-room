import { describe, expect, it } from 'vitest'
import { outputSchemas } from '../../src/shared/contracts'
import { InputTimingPayloadSchema, NativeCommandSchema, TimelineQuerySchema } from '../../src/shared/schemas'
import { createFixtureApi, FIXTURE_END, FIXTURE_START, WORKLOG_FIXTURE } from '../fixtures/worklog-fixtures'

describe('foundation fixtures and shared boundaries', () => {
  it('retains A -> ten seconds of Kim -> A and a separate gap', async () => {
    const reply = await createFixtureApi().timeline.query({ rangeStart: FIXTURE_START, rangeEnd: FIXTURE_END })
    expect(reply.ok).toBe(true)
    if (!reply.ok) throw new Error('Fixture query failed.')
    const page = outputSchemas['timeline.query'].parse(reply.data)
    expect(page.periods.map((period) => period.endTs - period.startTs)).toEqual([600_000, 10_000, 900_000])
    expect(page.filteredDurationMs).toBe(1_510_000)
    expect(page.coverage.gapMs).toBe(120_000)
  })

  it('keeps an expired observation and returns no image in a gap', async () => {
    const api = createFixtureApi()
    const expired = await api.timeline.resolveCursor({ cursorTs: FIXTURE_START + 605_000, queryRevision: 1 })
    expect(expired.ok).toBe(true)
    if (!expired.ok) throw new Error('Fixture cursor failed.')
    const cursor = outputSchemas['timeline.resolveCursor'].parse(expired.data)
    expect(cursor.period?.id).toBe(WORKLOG_FIXTURE.evidenceCases.expiredPeriodId)
    expect(cursor.evidence?.status).toBe('expired')
    const gap = await api.timeline.resolveCursor({ cursorTs: FIXTURE_END - 1, queryRevision: 1 })
    if (!gap.ok) throw new Error('Fixture gap failed.')
    expect(gap.data.period).toBeNull()
    expect(gap.data.evidence).toBeNull()
    expect(gap.data.gap?.reason).toBe('paused')
  })

  it('starts with text consent off and never turns fixture resume into real capture', async () => {
    const api = createFixtureApi()
    const settings = await api.settings.get({})
    if (!settings.ok) throw new Error('Fixture settings failed.')
    expect(settings.data.textConsent.enabled).toBe(false)
    expect(settings.data.textConsent.allowedBundleIds).toEqual([])
    const resumed = await api.capture.resume({ expectedRevision: 1 })
    expect(resumed.ok).toBe(false)
    if (resumed.ok) throw new Error('Fixture must not capture.')
    expect(resumed.error.code).toBe('CAPABILITY_BLOCKED')
    const status = await api.app.getStatus({})
    if (!status.ok) throw new Error('Fixture status failed.')
    expect(outputSchemas['app.getStatus'].parse(status.data).capture.state).toBe('paused')
  })

  it('accepts the minimal native hello and rejects unknown query/input fields', () => {
    expect(NativeCommandSchema.safeParse({
      protocolVersion: 1, helperSessionId: '11111111-1111-4111-8111-111111111111',
      requestId: '22222222-2222-4222-8222-222222222222', generation: 1,
      observationId: null, pid: null, windowId: null, kind: 'command', method: 'hello',
      issuedAt: FIXTURE_START, deadlineAt: FIXTURE_START + 3000, payload: { role: 'executor' }
    }).success).toBe(true)
    expect(TimelineQuerySchema.safeParse({ rangeStart: FIXTURE_START, rangeEnd: FIXTURE_END, sql: 'unsupported' }).success).toBe(false)
    expect(InputTimingPayloadSchema.safeParse({
      trigger: 'typing_pause', contextRevision: 1, activityStartedAt: FIXTURE_START,
      activityEndedAt: FIXTURE_START + 1000, quietDurationMs: 500, text: 'unsupported'
    }).success).toBe(false)
  })
})
