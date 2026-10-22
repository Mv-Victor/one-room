export interface WorkflowRecordingInput {
  title: string
  url: string
  parameterFields: string[]
  secretFields: string[]
}
export interface WorkflowRecording extends WorkflowRecordingInput {
  id: string
  createdAt: number
  state: 'starting' | 'browser_ready' | 'recording' | 'compiling' | 'ready' | 'failed'
  digest: string
  parameters: Record<string, string>
  steps: number
  error: string
}
export interface WorkflowBinding {
  engine: 'openadapt'
  recordingId: string
  digest: string
  parameters: Record<string, string>
  verification?: {
    url: string
    checks: { pointer: string; parameter: string }[]
  }
}
export interface WorkflowAPI {
  recordings(): Promise<WorkflowRecording[]>
  recordWorkflow(input: WorkflowRecordingInput): Promise<WorkflowRecording>
  beginRecording(id: string): Promise<void>
  stopRecording(id: string): Promise<void>
}
