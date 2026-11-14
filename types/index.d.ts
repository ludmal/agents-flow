// Where an agent stands, as the panel shows it. `starting` until its loop
// runs; `completed`, `failed` and `killed` (stopped) are final.
export type FlowStatus =
  | 'starting'
  | 'running'
  | 'waiting'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'killed'

// One agent the panel knows of: what it is, where it stands, what it costs.
export type FlowAgent = {
  id: string
  name: string
  type: string
  description: string
  parentId?: string
  isTeammate?: boolean
  // A workflow script's agent, which `$.agent.list()` never names.
  isWorkflow?: boolean
  model?: string
  effort?: string
  status: FlowStatus
  startedAt: number
  endedAt?: number
  tokens?: number
  tools: number
  activity?: string
  // Task ids this agent created or updated, true once completed.
  tasks: Record<string, boolean>
  todos?: { done: number; total: number }
  // Median duration of earlier runs of this agent type, when known.
  expectMs?: number
  // Progress frozen when the agent ended.
  finalP?: number
}

// What the panel draws: the agents, as of `at` (ms since the epoch).
export type Flow = { at: number; agents: FlowAgent[] }

declare module 'claude-code' {
  interface PluginState {
    'agents-flow': { flow: Shaped<Flow> }
  }
}
