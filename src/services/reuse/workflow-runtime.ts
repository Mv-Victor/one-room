import fs from 'node:fs'
import path from 'node:path'
import { CodexExecutor } from './agent-executor'
import { WorkflowExecutor } from './workflow-executor'
import { WorkflowService } from './workflow-service'

export function createWorkflowExecutor(root: string): WorkflowExecutor {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || ''
  const packaged = path.join(resources, 'openadapt')
  const runtime =
    process.env.ONE_ROOM_WORKFLOW_RUNTIME ||
    (fs.existsSync(packaged) ? packaged : path.resolve('build/openadapt'))
  return new WorkflowExecutor(
    new WorkflowService(
      path.join(root, 'workflows'),
      runtime,
      path.join(runtime, 'workflow_bridge.py'),
    ),
    new CodexExecutor(root),
  )
}
