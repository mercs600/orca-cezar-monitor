// Runs src/worker.ts's activate(orca) over a mock host, with the cockpits faked by a fetch stub:
// JSON for /projects, /runs and /history, and a controllable server-sent event stream for /events.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import type { Run } from './model'
import type { MonitorState } from './protocol'
import * as main from './worker'

const realFetch = globalThis.fetch
const mounted: { deactivate(): Promise<void> }[] = []
afterEach(async () => {
  // A failed assertion skips the test's own deactivate: stop its streams and timers here.
  await Promise.all(mounted.splice(0).map((w) => w.deactivate().catch(() => undefined)))
  globalThis.fetch = realFetch
})
const mount = async (host: ReturnType<typeof mockHost>) => {
  const w = await mountWorker(main, { host })
  mounted.push(w)
  return w
}

type Cockpit = { projects: string[]; runs: Record<string, Run[]>; status?: number }
type Fake = {
  calls: string[]
  /** Sends a `run` event on every open stream of that host and project. */
  push(host: string, project: string, run: Run): void
  /** Sends a raw event block. */
  send(host: string, project: string, block: string): void
}

function fakeCockpits(cockpits: Record<string, Cockpit>): Fake {
  const calls: string[] = []
  const streams: { host: string; project: string; ctl: ReadableStreamDefaultController<Uint8Array> }[] = []
  const enc = new TextEncoder()
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const auth = (init?.headers as Record<string, string>)?.authorization
    calls.push(`${url.host}${url.pathname} ${auth ? Buffer.from(auth.slice(6), 'base64').toString() : 'anon'}`)
    const c = cockpits[url.host]
    if (!c) {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    }
    if (c.status) {
      return new Response('{}', { status: c.status })
    }
    const path = url.pathname.replace(/^\/api\/v1/, '')
    if (path === '/projects') {
      return Response.json({ projects: c.projects.map((id) => ({ id })) })
    }
    const m = path.match(/^\/p\/([^/]+)\/(runs|events)$/)
    if (m?.[2] === 'runs') {
      return Response.json(c.runs[decodeURIComponent(m[1])] ?? [])
    }
    if (m?.[2] === 'events') {
      const body = new ReadableStream<Uint8Array>({
        start(ctl) {
          const entry = { host: url.host, project: decodeURIComponent(m[1]), ctl }
          streams.push(entry)
          ctl.enqueue(enc.encode('event: ping\ndata: \n\n'))
          init?.signal?.addEventListener('abort', () => {
            try {
              ctl.error(new Error('aborted'))
            } catch {
              // already closed
            }
          })
        }
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    if (/\/history$/.test(path)) {
      return Response.json({ events: [{ type: 'check-output', stepId: 'validate', exitCode: 1, text: '✘ jest: 2 failed' }] })
    }
    return new Response('nope', { status: 404 })
  }) as typeof fetch
  return {
    calls,
    push(host, project, run) {
      for (const s of streams.filter((x) => x.host === host && x.project === project)) {
        s.ctl.enqueue(enc.encode(`event: run\ndata: ${JSON.stringify({ ...run, workflowDef: { heavy: true } })}\n\n`))
      }
    },
    send(host, project, block) {
      for (const s of streams.filter((x) => x.host === host && x.project === project)) {
        s.ctl.enqueue(enc.encode(block))
      }
    }
  }
}

const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()
const get = async (w: { request(n: string): Promise<unknown> }) => (await w.request('cezar.get')) as MonitorState
/** Polls the worker's state until `ok` holds (or 5 s pass, then answers the last state): the
 *  worker works on its own timers, child processes and streams, so a fixed wait is flaky. */
async function until(
  w: { request(n: string): Promise<unknown> },
  ok: (s: MonitorState) => boolean,
  ms = 5000
): Promise<MonitorState> {
  const end = Date.now() + ms
  let s = await get(w)
  while (!ok(s) && Date.now() < end) {
    await settle(50)
    s = await get(w)
  }
  return s
}
/** Waits until the last status bar text is `text` (or 5 s pass). */
async function barText(host: ReturnType<typeof mockHost>, text: string): Promise<{ text: string; tone: string }> {
  const end = Date.now() + 5000
  const last = () => (host.callsOf('statusBar.update').at(-1) ?? { text: '', tone: '' }) as { text: string; tone: string }
  while (last().text !== text && Date.now() < end) {
    await settle(50)
  }
  return last()
}
const firstProject = (s: MonitorState) => s.snapshot?.cockpits[0]?.projects[0]

test('loads each watched project once, then follows its event stream', async () => {
  const fake = fakeCockpits({
    'a.example:4443': {
      projects: ['app', 'other'],
      runs: {
        app: [
          {
            id: 'r2-fail',
            title: 'broken',
            status: 'failed',
            finishedAt: now(),
            error: 'check "validate" failed',
            steps: [{ id: 'validate', status: 'failed' }]
          }
        ]
      }
    }
  })
  const host = mockHost({
    settings: { cockpits: 'https://a.example:4443 app' },
    secrets: { 'login:a.example': 'user', 'password:a.example': 'pw' }
  })
  const worker = await mount(host)
  let s = await until(worker, (x) => Boolean(x.snapshot?.cockpits[0]?.streaming && firstProject(x)?.problems[0]?.detail.includes('jest')))
  const c = s.snapshot!.cockpits[0]
  assert.deepEqual(c.available, ['app', 'other'])
  assert.equal(c.credentialSource, 'plugin')
  assert.equal(c.streaming, true)
  assert.equal(c.projects.length, 1)
  assert.equal(c.projects[0].problems[0].detail, 'validate: ✘ jest: 2 failed')
  assert.ok(fake.calls.every((x) => x.endsWith(' user:pw')))
  assert.ok(!fake.calls.some((x) => x.includes('/p/other/')), 'an unwatched project is not read')

  fake.push('a.example:4443', 'app', {
    id: 'r1-live',
    title: 'live',
    status: 'running',
    startedAt: now(),
    steps: [{ id: 'impl', name: 'Implement', status: 'running' }]
  })
  s = await until(worker, (x) => Boolean(firstProject(x)?.live[0]))
  assert.equal(s.snapshot!.cockpits[0].projects[0].live[0].step, 'Implement')
  assert.equal(fake.calls.filter((x) => x.includes('/p/app/runs ')).length, 1, 'the full list is read once, not polled')
  const bar = await barText(host, 'Cezar 🔴 1 🟢 1')
  assert.equal(bar.text, 'Cezar 🔴 1 🟢 1')
  assert.equal(bar.tone, 'danger')
  // First look seeds what is already broken: no notification for it.
  assert.equal(host.callsOf('notifications.show').length, 0)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a run started after the first load appears from the stream, and leaves on run-deleted', async () => {
  const fake = fakeCockpits({ 'a.example:4443': { projects: ['app'], runs: { app: [] } } })
  const host = mockHost({ settings: { cockpits: 'https://a.example:4443' } })
  const worker = await mount(host)
  await until(worker, (x) => Boolean(x.snapshot?.cockpits[0]?.streaming))
  fake.push('a.example:4443', 'app', { id: 'new-1', title: 'świeże zadanie', status: 'queued', createdAt: now() })
  let s = await until(worker, (x) => Boolean(firstProject(x)?.live[0]))
  assert.equal(firstProject(s)?.live[0]?.id, 'new-1')
  fake.send('a.example:4443', 'app', 'event: run-deleted\ndata: {"id":"new-1"}\n\n')
  s = await until(worker, (x) => firstProject(x)?.live.length === 0)
  assert.equal(firstProject(s)?.live.length, 0)
  await worker.deactivate()
})

test('a failure arriving on the stream is notified once; dismissing clears the count', async () => {
  const fake = fakeCockpits({ 'a.example:4443': { projects: ['app'], runs: { app: [] } } })
  const host = mockHost({ settings: { cockpits: 'https://a.example:4443' }, secrets: { 'login:a.example': 'u', 'password:a.example': 'p' } })
  const worker = await mount(host)
  await until(worker, (x) => Boolean(x.snapshot?.cockpits[0]?.streaming))
  fake.push('a.example:4443', 'app', { id: 'r3', title: 'nowy', status: 'failed', finishedAt: now(), error: 'boom' })
  await until(worker, (x) => Boolean(firstProject(x)?.problems[0]))
  const end = Date.now() + 5000
  while (!host.callsOf('notifications.show').length && Date.now() < end) {
    await settle(50)
  }
  fake.push('a.example:4443', 'app', { id: 'r3', title: 'nowy', status: 'failed', finishedAt: now(), error: 'boom' })
  await settle()
  const shown = host.callsOf('notifications.show') as { title: string }[]
  assert.equal(shown.length, 1)
  assert.ok(shown[0].title.includes('nowy'))
  const s = (await worker.request('cezar.dismiss', { keys: ['r3:failed'] })) as MonitorState
  assert.deepEqual(s.dismissed, ['r3:failed'])
  const bar = await barText(host, 'Cezar')
  assert.equal(bar.text, 'Cezar')
  await worker.deactivate()
})

test('several cockpits: each with its own login; one refusing does not hide the other', async () => {
  const fake = fakeCockpits({
    'a.example:4443': { projects: ['app'], runs: { app: [{ id: 'q', title: 'czeka', status: 'queued' }] } },
    'b.example:4443': { projects: [], runs: {}, status: 401 }
  })
  const host = mockHost({
    settings: { cockpits: 'https://a.example:4443\nhttps://b.example:4443' },
    secrets: { 'login:a.example': 'ua', 'password:a.example': 'pa', 'login:b.example': 'ub', 'password:b.example': 'bad' }
  })
  const worker = await mount(host)
  const s = await until(worker, (x) => Boolean(x.snapshot?.cockpits[0]?.projects[0]?.live.length && x.snapshot?.cockpits[1]?.error))
  const [a, b] = s.snapshot!.cockpits
  assert.equal(a.projects[0].live.length, 1)
  assert.ok(b.error?.startsWith('401'))
  assert.ok(fake.calls.some((x) => x.startsWith('b.example:4443/api/v1/projects ub:bad')))
  const bar = await barText(host, 'Cezar 🔴 1 🟢 1')
  assert.equal(bar.text, 'Cezar 🔴 1 🟢 1')
  await worker.deactivate()
})

test('a project picked in the panel is written to the cockpits setting', async () => {
  fakeCockpits({ 'a.example:4443': { projects: ['app', 'api'], runs: {} } })
  const host = mockHost({ settings: { cockpits: 'https://a.example:4443' } })
  const worker = await mount(host)
  await until(worker, (x) => Boolean(x.snapshot?.cockpits[0]?.available.length))
  await worker.request('cezar.setProjects', { cockpit: 'https://a.example:4443', projects: ['api'] })
  assert.equal(host.data().settings.cockpits, 'https://a.example:4443 api')
  await worker.deactivate()
})
