import { z } from 'zod'

export const ErrorCodeSchema = z.enum([
  'INVALID_ARGUMENT', 'NOT_FOUND', 'STALE_REVISION', 'PERMISSION_DENIED',
  'CONSENT_REQUIRED', 'SOURCE_INVALIDATED', 'CAPABILITY_BLOCKED', 'CONFLICT',
  'AUTH_REQUIRED', 'TIMEOUT', 'CANCELED', 'BUSY', 'INTERNAL'
])

export const AppErrorSchema = z.strictObject({
  code: ErrorCodeSchema,
  detailCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).optional(),
  message: z.string().min(1).max(500),
  retryable: z.boolean()
})

export type ErrorCode = z.infer<typeof ErrorCodeSchema>
export type AppError = z.infer<typeof AppErrorSchema>

export class DomainError extends Error {
  readonly error: AppError

  constructor(code: ErrorCode, message: string, detailCode?: string, retryable = false) {
    super(message)
    this.name = 'DomainError'
    this.error = AppErrorSchema.parse({ code, message, detailCode, retryable })
  }
}

// Unexpected errors never expose local paths, document contents, or stderr to renderer.
export function toAppError(error: unknown): AppError {
  if (error instanceof DomainError) return error.error
  if (error instanceof z.ZodError) {
    return { code: 'INVALID_ARGUMENT', message: 'Invalid request.', retryable: false }
  }
  return { code: 'INTERNAL', message: 'The operation could not be completed.', retryable: false }
}
