import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

type World = {
  panes: Set<string>
  statuses: Array<string | undefined>
  list: AgentInfo[]
}

// Each hook here stands for the engine beneath the mod: a call on `$` is
// answered `{ value }`, an event by its own result.
const engine = (on: On): World => {
  const world: World = { panes: new Set(), statuses: [], list: [] }
  on('command.register', () => ({ value: { command: 'agents-flow' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', (_, e) => {
    world.panes.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    world.panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...world.panes].map(id => ({
      id,
      title: 'Agents',
      isShown: true,
      isFocused: false,
      isPlaced: true,
    })),
  }))
  on('ui.status', (_, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: world.list }))
  on('agent.spawn', (_, e) => {
    // The engine lists a started agent until it ends.
    world.list.push({ id: 'a1', description: e.description, type: e.subagentType, status: 'running' })
    return { model: 'claude-opus-5-5', agentId: 'a1' }
  })
  let tasks = 0
  on('tool.call', (_, e) => {
    if (String(e.tool) !== 'TaskCreate') return { result: {} }
    tasks += 1
    return { result: { task: { id: String(tasks), subject: 'task' } } }
  })
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        input_tokens: 1000,
        output_tokens: 400,
        cache_read_input_tokens: 80_000,
        cache_creation_input_tokens: 0,
        model: e.model,
      },
    }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return world
}

const pane = (placement: 'dock' | 'inline', bodyColumns: number) =>
  ({
    plugin: 'agents-flow',
    component: 'Pane',
    requestId: 'agents-flow',
    props: {
      title: 'Agents',
      isFocused: false,
      bodyColumns,
      placement,
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'Build the billing page',
  description: 'Build billing page',
  subagentType: 'developer',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
} as const

const step = async ($: Engine): Promise<void> => {
  const stream = $.turn.step({
    turnId: 't1',
    index: 0,
    model: 'claude-opus-5-5',
    effort: 'max',
    messageCount: 3,
    agentId: 'a1',
  })
  for await (const _ of stream) {
    // drain
  }
  await stream.result
}

test('the command opens the panel and closes it again', async ($, on) => {
  const world = engine(on)
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const opened = await $.command.run({
    command: 'agents-flow',
    args: '',
    origin: { kind: 'person' },
    presentation: { isFullscreen: true, columns: 160 },
  } as never)
  expect(opened.text).toMatch(/open/)
  expect(world.panes.has('agents-flow')).toBe(true)

  const closed = await $.command.run({
    command: 'agents-flow',
    args: '',
    origin: { kind: 'person' },
    presentation: { isFullscreen: true, columns: 160 },
  } as never)
  expect(closed.text).toMatch(/closed/)
  expect(world.panes.has('agents-flow')).toBe(false)
})

test('a running agent shows its name, model, effort, activity and task progress', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn(SPAWN)
  await step($)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/app/billing/page.tsx', old_string: 'a', new_string: 'b', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'one', description: 'one', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'two', description: 'two', agentId: 'a1' } as never)
  await clock.advance(3000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane('dock', 46), surface })
    expect((await ui.find({ type: 'Text', text: 'developer' }))?.text).toBe('developer')
    expect((await ui.find({ type: 'Text', text: /opus 5\.5 · max/ }))?.text).toBe('opus 5.5 · max')
    expect(await ui.find({ type: 'Text', text: /81\.4k tok/ })).toBeDefined()
    expect(await ui.find({ text: /0\/2 tasks/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↳ New task: two/ })).toBeDefined()
    await ui.unmount()
  }
})

test('task updates move the bar, and a finished agent reads done', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress', agentId: 'a1' } as never)
  await clock.advance(1000)

  let ui = await $.ui.mount({ ...pane('dock', 46), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /50%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/2 tasks/ })).toBeDefined()
  await ui.unmount()

  await $.turn.complete({
    reason: 'answer',
    answer: 'Done.',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    agentId: 'a1',
  })
  await clock.advance(1000)

  ui = await $.ui.mount({ ...pane('dock', 46), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 done/ })).toBeDefined()
  await ui.unmount()
})

test('with the panel closed, the status line counts running agents', async ($, on) => {
  const world = engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn(SPAWN)
  await clock.advance(1000)
  expect(world.statuses.at(-1)).toBe('● 1 agent running · /agents-flow')
})

test('the inline pane draws one line per agent', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn(SPAWN)
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...pane('inline', 120), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'developer' }))?.text).toBe('developer')
  expect(await ui.find({ type: 'Text', text: /AGENTS/ })).toBeDefined()
  await ui.unmount()
})

test('an empty panel says no agents yet', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...pane('dock', 46), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No agents yet/ })).toBeDefined()
  await ui.unmount()
})

test('a general-purpose agent goes by its task, a named type by its type', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose', description: 'Review billing files' })
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...pane('dock', 46), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'Review billing files' }))?.text).toBe('Review billing files')
  expect(await ui.find({ type: 'Text', text: /thinking…/ })).toBeDefined()
  await ui.unmount()
})

test('an agent the engine stops listing reads done', async ($, on) => {
  const world = engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn(SPAWN)
  await clock.advance(1000)
  world.list.length = 0
  await clock.advance(3000)

  const ui = await $.ui.mount({ ...pane('dock', 46), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 done/ })).toBeDefined()
  await ui.unmount()
})

test('the bar estimates from past runs, then says when it takes longer', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { runs: { developer: [10_000] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn(SPAWN)
  await clock.advance(4000)
  let ui = await $.ui.mount({ ...pane('dock', 46), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /~40%/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(8000)
  ui = await $.ui.mount({ ...pane('dock', 46), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /taking longer/ })).toBeDefined()
  await ui.unmount()
})

test('a block titles the job, then the step its task list has in progress', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn({ ...SPAWN, description: 'Fix web unit tests' })
  await clock.advance(1000)
  let ui = await $.ui.mount({ ...pane('dock', 46), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'developer' }))?.text).toBe('developer')
  expect(await ui.find({ type: 'Text', text: /^Fix web unit tests/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↳ thinking…/ })).toBeDefined()
  await ui.unmount()

  await $.tool.call({ tool: 'TaskCreate', subject: 'Run web tests', description: 'x', activeForm: 'Running the web unit tests', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress', agentId: 'a1' } as never)
  await clock.advance(1000)
  ui = await $.ui.mount({ ...pane('dock', 46), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: / · Running the web unit tests/ })).toBeDefined()
  await ui.unmount()

  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed', agentId: 'a1' } as never)
  await clock.advance(1000)
  ui = await $.ui.mount({ ...pane('dock', 46), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Running the web unit tests/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Fix web unit tests/ })).toBeDefined()
  await ui.unmount()
})

test('a todo list in progress titles the step, under a task-named agent too', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose', description: 'Review billing files' })
  const todos = [
    { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
    { content: 'Watch the web unit tests', status: 'in_progress', activeForm: 'Watching the web unit tests' },
  ]
  await $.tool.call({ tool: 'TodoWrite', todos, agentId: 'a1' } as never)
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...pane('dock', 46), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'Review billing files' }))?.text).toBe('Review billing files')
  expect(await ui.find({ type: 'Text', text: /^Watching the web unit tests/ })).toBeDefined()
  expect(await ui.find({ text: /1\/2 todos/ })).toBeDefined()
  await ui.unmount()
})

test('the inline row carries the job beside the name', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn({ ...SPAWN, description: 'Fix web unit tests' })
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...pane('inline', 140), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: / · Fix web unit tests/ })).toBeDefined()
  await ui.unmount()
})
