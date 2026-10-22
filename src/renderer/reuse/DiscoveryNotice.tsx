import { useEffect, useState } from 'react'
import { ArrowRight, X, Workflow } from 'lucide-react'
import type { Candidate, ReuseAPI } from '../../services/reuse/types'
import './sop-workbench.css'

export function DiscoveryNotice({
  api,
  onOpen,
}: {
  api: ReuseAPI
  onOpen(): void
}): React.JSX.Element | null {
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [dismissed, setDismissed] = useState<string[]>([])
  useEffect(() => {
    let active = true,
      busy = false
    const refresh = async () => {
      if (busy) return
      busy = true
      try {
        const rows = await api.candidates()
        if (active)
          setCandidate(
            rows.find((row) => row.status === 'new' && !dismissed.includes(row.id)) || null,
          )
      } catch {
        /* capture and navigation remain available if discovery is unavailable */
      } finally {
        busy = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 15000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [api, dismissed])
  if (!candidate) return null
  return (
    <div className="or-discovery-notice" role="status">
      <Workflow size={18} />
      <span>
        发现可复用流程：{candidate.title} · 已观察到 {candidate.instances} 次独立操作
      </span>
      <button onClick={onOpen} title="查看 SOP 候选">
        <ArrowRight size={17} />
        <span>查看</span>
      </button>
      <button title="本次稍后提醒" onClick={() => setDismissed((ids) => [...ids, candidate.id])}>
        <X size={17} />
      </button>
    </div>
  )
}
