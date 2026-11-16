import { atom, read, update } from 'claude-code'
import type {
  AgentStatus,
  ElementTable,
  EngineInterface,
  Register,
  RenderElement,
} from 'claude-code'

import type { Flow, FlowAgent, FlowStatus } from '../types'

const PANE = 'agents-flow'
const AMBER = '#FFB000'
// Muted fills: a `dimColor` Text draws gray here, so muted colors are explicit.
const AMBER_MUTED = '#A87400'
const GREEN_MUTED = '#3E8E5E'
const RED_MUTED = '#A04545'
const TICK_MS = 1000
// Ticks an agent may be missing from `$.agent.list()` before it counts as ended.
const MISSING_TICKS = 3
const LINGER_MS = 120_000
const KEEP_RUNS = 10
const SHIMMER = 6
const DOCK_COLUMNS = 46

// Bump the shape when FlowAgent changes: it declines what an older version
// stored, which outlives a reload.
const flowState = atom(
  { plugin: 'agents-flow', key: 'flow' } as const,
  { at: 0, agents: [] },
  { shape: 'flow-2' },
)

type Dollar = EngineInterface
type Table = Pick<ElementTable<'terminal'>, 'Box' | 'Text' | 'Button' | 'Progress'>
type Usage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}
type Progress = { p?: number; pct: string; note: string }
type Look = { glyph: string; glyphColor: string; barColor: string; labelColor: string }
type RowView = {
  id: string
  seed: number
  depth: number
  name: string
  job: string
  step: string
  isFinal: boolean
  isMoving: boolean
  look: Look
  meta: string
  elapsed: string
  tokens: string
  activity: string
  progress: Progress
}

const FINAL = new Set<FlowStatus>(['completed', 'failed', 'killed'])
const isFinal = (status: FlowStatus): boolean => FINAL.has(status)
const isBusy = (a: FlowAgent): boolean => !isFinal(a.status) && a.status !== 'idle'
const fromAgentStatus = (status: AgentStatus): FlowStatus =>
  status === 'pending' ? 'starting' : status

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))
const percent = (p: number): string => `${Math.round(clamp(p, 0, 1) * 100)}%`

// 'claude-opus-5-5' → 'opus 5.5'; 'claude-3-5-haiku-20241022' → 'haiku 3.5'.
const shortModel = (id: string | undefined): string => {
  if (id === undefined || id === '') return ''
  const modern = /(opus|sonnet|haiku|fable)[-_ ]?(\d{1,2})(?:[-.](\d{1,2}))?(?!\d)/i.exec(id)
  if (modern) {
    const minor = modern[3] === undefined ? '' : `.${modern[3]}`
    return `${(modern[1] ?? '').toLowerCase()} ${modern[2] ?? ''}${minor}`
  }
  const legacy = /claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)/i.exec(id)
  if (legacy) {
    const minor = legacy[2] === undefined ? '' : `.${legacy[2]}`
    return `${(legacy[3] ?? '').toLowerCase()} ${legacy[1] ?? ''}${minor}`
  }
  return id.replace(/^claude-/, '')
}

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(s % 60)}s`
}

const ago = (ms: number): string => (ms < 60_000 ? 'just now' : `${Math.floor(ms / 60_000)}m ago`)

const tokenText = (n: number | undefined): string => {
  if (n === undefined) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M tok`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`
  return `${n} tok`
}

const tokensOf = (u: Usage): number =>
  u.input_tokens +
  u.output_tokens +
  (u.cache_creation_input_tokens ?? 0) +
  (u.cache_read_input_tokens ?? 0)

const median = (xs: readonly number[] | undefined): number | undefined => {
  if (xs === undefined || xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

const oneLine = (text: string, max = 80): string => {
  const line = (text.split('\n', 1)[0] ?? '').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const shortPath = (path: string): string => {
  const parts = path.split('/').filter(part => part !== '')
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join('/')}`
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return oneLine(url, 40)
  }
}

// What a tool call is doing, in a few words: 'Edit …/billing/page.tsx'.
const describeCall = (tool: string, input: Record<string, unknown>): string => {
  const s = (key: string): string => {
    const value = input[key]
    return typeof value === 'string' ? value : ''
  }
  switch (tool) {
    case 'Bash':
      return `Bash ${oneLine(s('command'))}`
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return `${tool} ${shortPath(s('file_path'))}`
    case 'NotebookEdit':
      return `NotebookEdit ${shortPath(s('notebook_path'))}`
    case 'Grep':
      return `Grep "${oneLine(s('pattern'), 40)}"`
    case 'Glob':
      return `Glob ${oneLine(s('pattern'), 40)}`
    case 'WebFetch':
      return `WebFetch ${hostOf(s('url'))}`
    case 'WebSearch':
      return `WebSearch "${oneLine(s('query'), 40)}"`
    case 'Agent':
    case 'Task':
      return `Agent ${s('subagent_type') || 'general-purpose'}: ${oneLine(s('description'), 40)}`
    case 'TaskCreate':
      return `New task: ${oneLine(s('subject'), 50)}`
    case 'TaskUpdate':
      return s('status') === '' ? `Task #${s('taskId')}` : `Task #${s('taskId')} → ${s('status')}`
    case 'TodoWrite':
      return 'Updating its todo list'
    case 'Skill':
      return `Skill ${s('skill')}`
  }
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.split('__')
    return `${server}: ${name}`
  }
  return tool
}

const textOf = (value: unknown): string => (typeof value === 'string' ? oneLine(value) : '')

const todosOf = (raw: unknown): { done: number; total: number } | undefined => {
  if (!Array.isArray(raw)) return undefined
  const done = raw.filter(
    todo =>
      typeof todo === 'object' &&
      todo !== null &&
      (todo as { status?: unknown }).status === 'completed',
  ).length
  return { done, total: raw.length }
}

// The todo in progress: 'Running the web unit tests'.
const todoStepOf = (raw: unknown): string | undefined => {
  if (!Array.isArray(raw)) return undefined
  const now = raw.find(
    todo =>
      typeof todo === 'object' &&
      todo !== null &&
      (todo as { status?: unknown }).status === 'in_progress',
  ) as { activeForm?: unknown; content?: unknown } | undefined
  if (now === undefined) return undefined
  return textOf(now.activeForm) || textOf(now.content) || undefined
}

const taskIdOf = (result: unknown): string | undefined => {
  if (typeof result !== 'object' || result === null) return undefined
  const task = (result as { task?: unknown }).task
  if (typeof task !== 'object' || task === null) return undefined
  const id = (task as { id?: unknown }).id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
}

// Task ids the agent created or updated, each true once completed.
const noteTask = (
  a: FlowAgent,
  tool: string,
  input: Record<string, unknown>,
  ran: { deny?: unknown; isError?: unknown; result?: unknown },
): void => {
  if (ran.deny !== undefined || ran.isError === true) return
  const label = textOf(input.activeForm) || textOf(input.subject)
  if (tool === 'TaskCreate') {
    const id = taskIdOf(ran.result)
    if (id === undefined) return
    a.tasks[id] = false
    if (label !== '') a.labels[id] = label
    return
  }
  const raw = input.taskId
  if (typeof raw !== 'string' && typeof raw !== 'number') return
  const id = String(raw)
  const status = input.status
  if (status === 'deleted') {
    delete a.tasks[id]
    delete a.labels[id]
    if (a.stepId === id) delete a.stepId
    return
  }
  if (label !== '') a.labels[id] = label
  if (status === 'in_progress') a.stepId = id
  else if ((status === 'completed' || status === 'pending') && a.stepId === id) delete a.stepId
  a.tasks[id] =
    status === 'completed'
      ? true
      : status === 'pending' || status === 'in_progress'
        ? false
        : (a.tasks[id] ?? false)
}

// What the agent says it is doing now, from its own task or todo list.
const stepOf = (a: FlowAgent): string => {
  if (isFinal(a.status)) return ''
  if (a.stepId !== undefined) return a.labels[a.stepId] ?? ''
  return a.todoStep ?? ''
}

// The job it was given, unless its name already says it.
const jobOf = (a: FlowAgent): string => {
  const job = oneLine(a.description)
  return job === '' || a.name === oneLine(a.description, 40) ? '' : job
}

const parseRuns = (raw: unknown): Record<string, number[]> => {
  const out: Record<string, number[]> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [type, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue
    out[type] = list
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
      .slice(-KEEP_RUNS)
  }
  return out
}

// The bar's fill: the agent's task list, else its todo list, else how long
// this agent type took before, else nothing known (a moving shimmer).
const progressOf = (a: FlowAgent, at: number): Progress => {
  if (a.status === 'completed') return { p: 1, pct: 'done', note: '' }
  const ids = Object.keys(a.tasks)
  let base: Progress = { pct: '', note: 'working' }
  if (ids.length > 0) {
    const done = ids.filter(id => a.tasks[id] === true).length
    base = { p: done / ids.length, pct: percent(done / ids.length), note: `${done}/${ids.length} tasks` }
  } else if (a.todos !== undefined && a.todos.total > 0) {
    const p = a.todos.done / a.todos.total
    base = { p, pct: percent(p), note: `${a.todos.done}/${a.todos.total} todos` }
  } else if (a.expectMs !== undefined && a.expectMs > 0) {
    // Past its usual time the estimate says nothing: back to the shimmer.
    const ratio = (at - a.startedAt) / a.expectMs
    const p = clamp(ratio, 0, 0.95)
    base = ratio <= 1 ? { p, pct: `~${percent(p)}`, note: 'est.' } : { pct: '', note: 'taking longer' }
  }
  switch (a.status) {
    case 'failed':
    case 'killed': {
      const p = a.finalP ?? base.p ?? 0
      return { p, pct: percent(p), note: a.status === 'failed' ? 'failed' : 'stopped' }
    }
    case 'waiting':
      return { ...base, note: 'waiting' }
    case 'idle':
      return { ...base, note: 'idle' }
    case 'starting':
      return { ...base, note: 'starting' }
    default:
      return base
  }
}

// A small number from an id, so each agent's shimmer runs at its own place.
const seedOf = (id: string): number => {
  let n = 0
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) % 9973
  return n
}

const barOf = (
  p: number | undefined,
  width: number,
  at: number,
  isMoving: boolean,
  seed: number,
): { pre: string; fill: string; track: string } => {
  if (p !== undefined) {
    const n = Math.round(clamp(p, 0, 1) * width)
    return { pre: '', fill: '█'.repeat(n), track: '░'.repeat(width - n) }
  }
  if (!isMoving) return { pre: '', fill: '', track: '░'.repeat(width) }
  const pos = ((Math.floor(at / TICK_MS) + seed) % (width + SHIMMER)) - SHIMMER
  const start = Math.max(0, pos)
  const end = clamp(pos + SHIMMER, 0, width)
  return {
    pre: '░'.repeat(start),
    fill: '█'.repeat(Math.max(0, end - start)),
    track: '░'.repeat(width - Math.max(start, end)),
  }
}

const lookOf = (status: FlowStatus): Look => {
  switch (status) {
    case 'completed':
      return { glyph: '✓', glyphColor: 'success', barColor: GREEN_MUTED, labelColor: 'success' }
    case 'failed':
      return { glyph: '✗', glyphColor: 'error', barColor: RED_MUTED, labelColor: 'error' }
    case 'killed':
      return { glyph: '■', glyphColor: 'inactive', barColor: 'inactive', labelColor: 'inactive' }
    case 'waiting':
      return { glyph: '◐', glyphColor: AMBER, barColor: AMBER_MUTED, labelColor: AMBER_MUTED }
    case 'idle':
      return { glyph: '◌', glyphColor: 'inactive', barColor: 'inactive', labelColor: 'inactive' }
    case 'starting':
      return { glyph: '○', glyphColor: AMBER, barColor: AMBER, labelColor: AMBER }
    default:
      return { glyph: '●', glyphColor: AMBER, barColor: AMBER, labelColor: AMBER }
  }
}

// Agents in spawn order, each followed by the agents it started.
const treeOf = (list: readonly FlowAgent[]): Array<[FlowAgent, number]> => {
  const ids = new Set(list.map(a => a.id))
  const kids = new Map<string, FlowAgent[]>()
  const roots: FlowAgent[] = []
  for (const a of [...list].sort((x, y) => x.startedAt - y.startedAt)) {
    if (a.parentId !== undefined && a.parentId !== a.id && ids.has(a.parentId)) {
      kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a])
    } else {
      roots.push(a)
    }
  }
  const out: Array<[FlowAgent, number]> = []
  const seen = new Set<string>()
  const walk = (a: FlowAgent, depth: number): void => {
    if (seen.has(a.id)) return
    seen.add(a.id)
    out.push([a, depth])
    for (const kid of kids.get(a.id) ?? []) walk(kid, Math.min(depth + 1, 3))
  }
  for (const root of roots) walk(root, 0)
  for (const a of list) walk(a, 0)
  return out
}

const activityOf = (a: FlowAgent, at: number): string => {
  if (a.status === 'completed') {
    const uses = `${a.tools} tool use${a.tools === 1 ? '' : 's'}`
    return `${uses} · finished ${ago(at - (a.endedAt ?? at))}`
  }
  if (a.status === 'killed') return 'Stopped'
  return a.activity ?? 'thinking…'
}

// Built-in types that say nothing about the work: such an agent goes by its task.
const GENERIC_TYPES = new Set(['general-purpose', 'fork', 'teammate'])
const displayNameOf = (name: string | undefined, type: string, description: string): string => {
  if (name !== undefined && name !== '') return name
  const task = oneLine(description, 40)
  return GENERIC_TYPES.has(type) && task !== '' ? task : type
}

const rowsOf = (flow: Flow): RowView[] =>
  treeOf(flow.agents).map(([a, depth]) => {
    const model = shortModel(a.model)
    const effort = a.effort === undefined ? '' : ` · ${a.effort}`
    return {
      id: a.id,
      seed: seedOf(a.id),
      depth,
      name: a.name,
      job: jobOf(a),
      step: stepOf(a),
      isFinal: isFinal(a.status),
      isMoving: a.status === 'running' || a.status === 'starting',
      look: lookOf(a.status),
      meta: model === '' ? 'model …' : `${model}${effort}`,
      elapsed: clock((a.endedAt ?? flow.at) - a.startedAt),
      tokens: tokenText(a.tokens),
      activity: activityOf(a, flow.at),
      progress: progressOf(a, flow.at),
    }
  })

const summaryOf = (list: readonly FlowAgent[]): string => {
  const count = (...statuses: FlowStatus[]): number =>
    list.filter(a => statuses.includes(a.status)).length
  const parts: Array<[number, string]> = [
    [count('running', 'starting'), 'running'],
    [count('waiting'), 'waiting'],
    [count('idle'), 'idle'],
    [count('completed'), 'done'],
    [count('failed'), 'failed'],
    [count('killed'), 'stopped'],
  ]
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ')
}

const statusLineOf = (list: readonly FlowAgent[]): string | undefined => {
  const running = list.filter(a => a.status === 'running' || a.status === 'starting').length
  const waiting = list.filter(a => a.status === 'waiting').length
  if (running + waiting === 0) return undefined
  const parts: string[] = []
  if (running > 0) parts.push(`${running} agent${running === 1 ? '' : 's'} running`)
  if (waiting > 0) parts.push(`${waiting} waiting`)
  return `● ${parts.join(' · ')} · /agents-flow`
}

const openAgent = async ($: Dollar, id: string): Promise<void> => {
  const shown = await $.ui.view({ agentId: id })
  if (shown.deny !== undefined) $.ui.toast(`agents-flow: can't show that transcript (${shown.deny})`)
}

const barLine = (
  t: Table,
  r: RowView,
  width: number,
  at: number,
  isTerminal: boolean,
): RenderElement => {
  const { Box, Text, Progress } = t
  const { p, pct, note } = r.progress
  if (!isTerminal) {
    return (
      <Progress
        label={note === '' ? r.name : note}
        value={p}
        color={r.look.barColor}
        valueText={pct === '' ? note : pct}
      />
    )
  }
  const bar = barOf(p, width, at, r.isMoving, r.seed)
  return (
    <Box>
      {bar.pre === '' ? null : <Text dimColor>{bar.pre}</Text>}
      {bar.fill === '' ? null : (
        <Text color={p === undefined ? AMBER_MUTED : r.look.barColor}>{bar.fill}</Text>
      )}
      {bar.track === '' ? null : <Text dimColor>{bar.track}</Text>}
      {pct === '' ? null : (
        <Text bold color={r.look.labelColor}>
          {`  ${pct}`}
        </Text>
      )}
      {note === '' ? null : <Text dimColor>{`  ${note}`}</Text>}
    </Box>
  )
}

const nameButton = ($: Dollar, t: Table, r: RowView): RenderElement => {
  const { Button, Text } = t
  return (
    <Button key={`open-${r.id}`} plain onPress={() => void openAgent($, r.id)}>
      <Text color={r.look.glyphColor}>{r.look.glyph}</Text>{' '}
      <Text bold={!r.isFinal} dimColor={r.isFinal} wrap="truncate-end">
        {r.name}
      </Text>
    </Button>
  )
}

// The job it was given, then the step it is on: 'Fix web unit tests · Running the tests'.
const titleLine = (t: Table, r: RowView): RenderElement | null => {
  const { Box, Text } = t
  if (r.job === '' && r.step === '') return null
  const step = r.step === '' ? '' : r.job === '' ? r.step : ` · ${r.step}`
  return (
    <Box paddingLeft={2}>
      <Text dimColor={r.isFinal} wrap="truncate-end">
        {r.job}
        {step === '' ? null : <Text color={r.look.labelColor}>{step}</Text>}
      </Text>
    </Box>
  )
}

const dockRow = (
  $: Dollar,
  t: Table,
  r: RowView,
  cols: number,
  at: number,
  isTerminal: boolean,
): RenderElement => {
  const { Box, Text } = t
  const pad = r.depth * 2
  const width = clamp(cols - pad - 2 - 17, 6, 24)
  return (
    <Box key={r.id} flexDirection="column" paddingLeft={pad} marginBottom={1}>
      <Box justifyContent="space-between">
        <Box>
          {r.depth > 0 ? <Text dimColor>└ </Text> : null}
          {nameButton($, t, r)}
        </Box>
        <Text dimColor>{r.elapsed}</Text>
      </Box>
      {titleLine(t, r)}
      <Box justifyContent="space-between" paddingLeft={2}>
        <Text dimColor wrap="truncate-end">
          {r.meta}
        </Text>
        {r.tokens === '' ? null : <Text dimColor>{r.tokens}</Text>}
      </Box>
      <Box paddingLeft={2}>{barLine(t, r, width, at, isTerminal)}</Box>
      {r.activity === '' ? null : (
        <Box paddingLeft={2}>
          <Text dimColor wrap="truncate-end">
            {`↳ ${r.activity}`}
          </Text>
        </Box>
      )}
    </Box>
  )
}

const header = (t: Table, flow: Flow): RenderElement => {
  const { Box, Text } = t
  return (
    <Box justifyContent="space-between">
      <Text bold color={AMBER}>
        AGENTS
      </Text>
      <Text dimColor>{summaryOf(flow.agents)}</Text>
    </Box>
  )
}

const drawDock = ($: Dollar, t: Table, flow: Flow, cols: number, isTerminal: boolean): RenderElement => {
  const { Box, Text } = t
  const rows = rowsOf(flow)
  const rule = '─'.repeat(cols)
  return (
    <Box flexDirection="column" width={cols}>
      {header(t, flow)}
      <Text dimColor>{rule}</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>No agents yet.</Text>
            <Text dimColor>They show up here as soon as one starts.</Text>
          </Box>
        ) : (
          rows.map(r => dockRow($, t, r, cols, flow.at, isTerminal))
        )}
      </Box>
      <Text dimColor>{rule}</Text>
      <Text dimColor wrap="truncate-end">
        click a name: transcript · ctrl+x x: close
      </Text>
    </Box>
  )
}

// One line per agent, for the pane above the prompt (no fullscreen).
const drawInline = ($: Dollar, t: Table, flow: Flow, cols: number, isTerminal: boolean): RenderElement => {
  const { Box, Text, Progress } = t
  const rows = rowsOf(flow)
  const metaW = 21
  const pctW = 6
  const noteW = 12
  const timeW = 8
  // The name column takes what the bar leaves, up to room for the job too.
  const nameW = clamp(cols - metaW - pctW - noteW - timeW - 24, 20, 48)
  const width = clamp(cols - nameW - metaW - pctW - noteW - timeW, 6, 30)
  return (
    <Box flexDirection="column" width={cols}>
      {header(t, flow)}
      {rows.length === 0 ? (
        <Text dimColor>No agents yet. They show up here as soon as one starts.</Text>
      ) : (
        rows.map(r => {
          const bar = barOf(r.progress.p, width, flow.at, r.isMoving, r.seed)
          const fillColor = r.progress.p === undefined ? AMBER_MUTED : r.look.barColor
          return (
            <Box key={r.id}>
              <Box width={nameW}>
                {r.depth > 0 ? <Text dimColor>{`${' '.repeat((r.depth - 1) * 2)}└ `}</Text> : null}
                {nameButton($, t, r)}
                {r.job === '' && r.step === '' ? null : (
                  <Text dimColor wrap="truncate-end">{` · ${r.job || r.step}`}</Text>
                )}
              </Box>
              <Box width={metaW}>
                <Text dimColor wrap="truncate-end">
                  {r.meta}
                </Text>
              </Box>
              <Box width={width}>
                {isTerminal ? (
                  <Box>
                    {bar.pre === '' ? null : <Text dimColor>{bar.pre}</Text>}
                    {bar.fill === '' ? null : <Text color={fillColor}>{bar.fill}</Text>}
                    {bar.track === '' ? null : <Text dimColor>{bar.track}</Text>}
                  </Box>
                ) : (
                  <Progress
                    label={r.progress.note === '' ? r.name : r.progress.note}
                    value={r.progress.p}
                    color={r.look.barColor}
                  />
                )}
              </Box>
              <Box width={pctW} justifyContent="flex-end">
                <Text bold color={r.look.labelColor}>
                  {r.progress.pct}
                </Text>
              </Box>
              <Box width={noteW}>
                <Text dimColor wrap="truncate-end">{` ${r.progress.note}`}</Text>
              </Box>
              <Box width={timeW} justifyContent="flex-end">
                <Text dimColor>{r.elapsed}</Text>
              </Box>
            </Box>
          )
        })
      )}
    </Box>
  )
}

// The module's working copy of what the panel shows. It starts over on a
// reload; `flowState` carries the agents across, and the tick publishes the
// copy there once a second.
const agents = new Map<string, FlowAgent>()
const memo: {
  runs: Record<string, number[]>
  isRunsDirty: boolean
  lastJson: string
  lastStatus: string | undefined
  isTicking: boolean
  timer: { cancel: () => void } | undefined
} = {
  runs: {},
  isRunsDirty: false,
  lastJson: '',
  lastStatus: undefined,
  isTicking: false,
  timer: undefined,
}

// Ticks in a row each agent has been missing from `$.agent.list()`.
const missing = new Map<string, number>()

const setStatus = (a: FlowAgent, status: FlowStatus, now: number, isTimed = true): void => {
  if (a.status === status) return
  if (isFinal(status)) {
    a.finalP = status === 'completed' ? 1 : progressOf(a, now).p
    a.endedAt = now
    // Learn how long this agent type takes, for the next run's estimate.
    if (isTimed && status === 'completed' && a.isTeammate !== true && now - a.startedAt >= 1000) {
      memo.runs[a.type] = [...(memo.runs[a.type] ?? []), now - a.startedAt].slice(-KEEP_RUNS)
      memo.isRunsDirty = true
    }
  } else {
    delete a.endedAt
  }
  a.status = status
}

const publish = async ($: Dollar, now: number, isForced: boolean): Promise<void> => {
  const list = [...agents.values()]
  const json = JSON.stringify(list)
  if (!isForced && json === memo.lastJson && !list.some(isBusy)) return
  memo.lastJson = json
  const snapshot: Flow = { at: now, agents: list.map(a => structuredClone(a)) }
  await update($, flowState, () => snapshot)
}

// Statuses the engine knows better: waiting on approval, idle teammates,
// agents that started before this module loaded, and agents that ended
// while it was reloading (no longer listed: counted done, not timed).
const reconcile = async ($: Dollar, now: number): Promise<void> => {
  const list = await $.agent.list()
  const listed = new Set(list.map(info => info.id))
  for (const a of agents.values()) {
    if (isFinal(a.status) || a.isWorkflow === true || listed.has(a.id)) {
      missing.delete(a.id)
      continue
    }
    const ticks = (missing.get(a.id) ?? 0) + 1
    missing.set(a.id, ticks)
    if (ticks >= MISSING_TICKS) {
      missing.delete(a.id)
      setStatus(a, 'completed', now, false)
    }
  }
  for (const info of list) {
    const status = fromAgentStatus(info.status)
    const known = agents.get(info.id)
    if (known === undefined) {
      if (isFinal(status)) continue
      agents.set(info.id, {
        id: info.id,
        name: displayNameOf(info.name, info.type, info.description),
        type: info.type,
        description: info.description,
        ...(info.parentId === undefined ? {} : { parentId: info.parentId }),
        ...(info.teammateId === undefined ? {} : { isTeammate: true }),
        status,
        startedAt: now,
        tools: 0,
        tasks: {},
        labels: {},
      })
      continue
    }
    if (!isFinal(known.status)) setStatus(known, status, now)
  }
}

const showStatus = ($: Dollar, isOpen: boolean): void => {
  const text = isOpen ? undefined : statusLineOf([...agents.values()])
  if (text === memo.lastStatus) return
  memo.lastStatus = text
  $.ui.status(text)
}

const tick = async ($: Dollar): Promise<void> => {
  if (memo.isTicking) return
  memo.isTicking = true
  try {
    const now = await $.clock.now()
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen || [...agents.values()].some(a => !isFinal(a.status))) await reconcile($, now)
    for (const [id, a] of agents) {
      if (isFinal(a.status) && now - (a.endedAt ?? now) > LINGER_MS) agents.delete(id)
    }
    await publish($, now, false)
    showStatus($, isOpen)
    if (memo.isRunsDirty) {
      memo.isRunsDirty = false
      await $.store.set('runs', memo.runs)
    }
  } catch {
    // The next tick tries again.
  } finally {
    memo.isTicking = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agents-flow',
      description: 'Show the agents at work in a side panel (run again to close it)',
      immediate: true,
    })
    const saved = await read($, flowState)
    for (const a of saved.agents) {
      if (!agents.has(a.id)) agents.set(a.id, structuredClone(a))
    }
    try {
      memo.runs = parseRuns(await $.store.get('runs'))
    } catch {
      memo.runs = {}
    }
    $.ui.status(undefined)
    memo.timer?.cancel()
    memo.timer = $.clock.every(TICK_MS, () => void tick($))
    return next(e)
  })

  on('command.run', { command: 'agents-flow' }, async $ => {
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isUp) {
      await $.ui.close({ id: PANE })
      memo.lastStatus = undefined
      await tick($)
      return { text: 'Agents panel closed.' }
    }
    await publish($, await $.clock.now(), true)
    const opened = await $.ui.open({ id: PANE, title: 'Agents', columns: DOCK_COLUMNS })
    showStatus($, true)
    return {
      text: opened.isPlaced
        ? 'Agents panel open. Run /agents-flow again to close it.'
        : `Agents panel is open but not drawn yet: ${opened.reason}`,
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.agentId === undefined) return ran
    const now = await $.clock.now()
    const known = agents.get(ran.agentId)
    if (known !== undefined) {
      // A resumed run, under the same id.
      known.status = 'running'
      known.startedAt = now
      known.model = ran.model
      delete known.endedAt
      delete known.finalP
      return ran
    }
    const type = e.fork ? 'fork' : e.subagentType
    const expectMs = median(memo.runs[type])
    agents.set(ran.agentId, {
      id: ran.agentId,
      name: displayNameOf(e.name, type, e.description),
      type,
      description: e.description,
      ...(e.parentAgentId === undefined ? {} : { parentId: e.parentAgentId }),
      ...(e.isTeammate === true ? { isTeammate: true } : {}),
      ...(e.workflow === undefined ? {} : { isWorkflow: true }),
      ...(expectMs === undefined ? {} : { expectMs }),
      model: ran.model,
      status: 'starting',
      startedAt: now,
      tools: 0,
      tasks: {},
      labels: {},
    })
    return ran
  }).catch(($, e, next) => next(e))

  // Each model request of an agent's loop: its model and effort as sent,
  // then the tokens its response used.
  on('turn.step', async function* ($, e, next) {
    const a = e.agentId === undefined ? undefined : agents.get(e.agentId)
    if (a !== undefined) {
      a.model = e.model
      if (e.effort !== undefined) a.effort = String(e.effort)
      if (a.status === 'starting') a.status = 'running'
    }
    const result = yield* next(e)
    if (a !== undefined && result.usage) a.tokens = tokensOf(result.usage)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    const a = e.agentId === undefined ? undefined : agents.get(e.agentId)
    if (a !== undefined && !isFinal(a.status)) {
      const ended: FlowStatus =
        a.isTeammate === true
          ? 'idle'
          : e.reason === 'answer'
            ? 'completed'
            : e.reason === 'aborted'
              ? 'killed'
              : 'failed'
      setStatus(a, ended, await $.clock.now())
    }
    return ran
  })

  on('tool.call', ($, e, next) => {
    const a = e.agentId === undefined ? undefined : agents.get(e.agentId)
    if (a === undefined) return next(e)
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    a.tools += 1
    a.activity = describeCall(tool, input)
    if (a.status === 'starting') a.status = 'running'
    if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
      a.todos = todosOf(input.todos)
      const step = todoStepOf(input.todos)
      if (step === undefined) delete a.todoStep
      else a.todoStep = step
    }
    if (tool !== 'TaskCreate' && tool !== 'TaskUpdate') return next(e)
    return next(e).then(ran => {
      noteTask(a, tool, input, ran)
      return ran
    })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const flow = await read($, flowState)
    const table = $.ui.resolve(e)
    const cols = Math.max(24, e.props.bodyColumns)
    const isTerminal = e.surface === 'terminal'
    // A dock draws the full rows; above the prompt or as a widget, one line each.
    return e.props.placement === 'inline' || e.props.placement === 'widget'
      ? drawInline($, table, flow, cols, isTerminal)
      : drawDock($, table, flow, cols, isTerminal)
  })
}
