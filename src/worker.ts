// The plugin's worker. It runs for as long as the plugin is enabled (the manifest contributes a
// status bar item) and watches one or more Cezar cockpits over their HTTP API (/api/v1 - the calls
// the cockpit's own page makes):
//   - once, and then every `fullRefreshMinutes`, the full run list of each watched project
//     (GET /p/<project>/runs - large: a busy project's list is several MB, so it is never polled);
//   - in between, the project's server-sent events (GET /p/<project>/events), whose `run` events
//     carry each run as it changes - so the panel is live without polling.
// It keeps the last snapshot in storage, updates the status bar, tells open panels and shows a
// desktop notification for each new failure, question or hold. It only reads the cockpits.
import type { OrcaWorkerApi } from 'orca/worker'
import { findCredentials, type Credentials } from './credentials'
import { cliAvailable, fetchTitle, parseRef, type Forge } from './forge'
import {
  counts,
  failureReason,
  formatCockpits,
  keepOwnForge,
  newProblems,
  parseCockpits,
  reasonsToRead,
  slimRun,
  summarize,
  type CockpitConfig,
  type CockpitSnapshot,
  type HistoryEvent,
  type Problem,
  type ProjectSnapshot,
  type Run,
  type Snapshot
} from './model'
import type { MonitorState } from './protocol'

const STATUS_ITEM = 'cezar-status'
const NOTIFY_KINDS = new Set<Problem['kind']>(['failed', 'waiting', 'held'])
const RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000]

type Settings = {
  cockpits: CockpitConfig[]
  fullRefreshMinutes: number
  windowHours: number
  notify: boolean
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** One watched cockpit: its login, the runs of its watched projects and their event streams. */
type Watch = {
  cfg: CockpitConfig
  host: string
  creds?: Credentials
  credsLoaded: boolean
  available: string[]
  /** Each project's repository URL (GET /projects), to tell its own issues from stray links. */
  repos: Map<string, string>
  error?: string
  runs: Map<string, Map<string, Run>>
  projectErrors: Map<string, string>
  streams: Map<string, AbortController>
  streaming: Set<string>
  retry?: ReturnType<typeof setTimeout>
  attempts: number
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })

let stop: (() => void) | undefined

export default function activate(orca: OrcaWorkerApi): void {
  let watches: Watch[] = []
  let generation = 0
  let loading = 0
  let dirtyTimer: ReturnType<typeof setTimeout> | undefined
  let fullTimer: ReturnType<typeof setInterval> | undefined
  let tickTimer: ReturnType<typeof setInterval> | undefined
  let reasons: Record<string, string> = {}
  /** GitLab titles by issue or MR URL; `title: null` = could not be read (retried after a while). */
  let titles: Record<string, { title: string | null; at: number }> = {}
  /** Which forge CLIs are installed: links to that forge are shown, with their titles. */
  const clis: Record<Forge, boolean> = { gitlab: false, github: false }
  /** A link is shown when its forge's CLI is installed; one no CLI reads (an unknown forge) too. */
  const linkable = (url: string | null | undefined): boolean => {
    const ref = parseRef(url)
    return Boolean(url) && (!ref || clis[ref.forge])
  }
  const life = new AbortController()
  // A stray rejection must not take the worker down (Orca marks a plugin errored after a few
  // crashes): log it to `orca plugin logs` instead.
  const onStray = (e: unknown) => orca.log(`unhandled: ${(e as Error)?.stack ?? String(e)}`)
  process.on('unhandledRejection', onStray)
  process.on('uncaughtException', onStray)

  async function readSettings(): Promise<Settings> {
    const s = await orca.settings.get()
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
    return {
      cockpits: parseCockpits(s.cockpits),
      fullRefreshMinutes: Math.max(5, num(s.fullRefreshMinutes, 30)),
      windowHours: num(s.windowHours, 24),
      notify: s.notify !== false
    }
  }

  // ---- HTTP -----------------------------------------------------------------------------

  async function credentials(w: Watch): Promise<Credentials | undefined> {
    if (!w.credsLoaded) {
      w.creds = await findCredentials(w.host, {
        login: (await orca.secrets.get(`login:${w.host}`)) ?? undefined,
        password: await orca.secrets.get(`password:${w.host}`)
      })
      w.credsLoaded = true
    }
    return w.creds
  }

  async function request(w: Watch, path: string, init: { accept?: string; signal?: AbortSignal } = {}): Promise<Response> {
    const c = await credentials(w)
    const headers: Record<string, string> = { accept: init.accept ?? 'application/json' }
    if (c) {
      headers.authorization = `Basic ${Buffer.from(`${c.login}:${c.password}`).toString('base64')}`
    }
    let res: Response
    try {
      res = await fetch(`${w.cfg.url}/api/v1${path}`, { headers, signal: init.signal ?? AbortSignal.timeout(60_000) })
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message
      throw new HttpError(0, `kokpit nie odpowiada (${cause}) - VPN?`)
    }
    if (res.status === 401) {
      w.credsLoaded = false // read the login again next time: it may have been fixed meanwhile
      throw new HttpError(
        401,
        c ? `401: złe hasło (${c.source}) albo brak dostępu do kokpitu` : `401: brak loginu - keychain cezar:${w.host}, netrc albo panel`
      )
    }
    if (!res.ok) {
      throw new HttpError(res.status, `${res.status} ${path}: ${(await res.text()).slice(0, 200)}`)
    }
    return res
  }

  const json = async <T>(w: Watch, path: string): Promise<T> => (await (await request(w, path)).json()) as T

  // ---- loading and streaming ------------------------------------------------------------

  const watchedOf = (w: Watch) => (w.cfg.projects.length ? w.cfg.projects : w.available)
  const pathOf = (project: string) => `/p/${encodeURIComponent(project)}`

  async function loadProject(w: Watch, project: string): Promise<void> {
    try {
      const data = await json<unknown[] | { runs: unknown[] }>(w, `${pathOf(project)}/runs`)
      const list = Array.isArray(data) ? data : data.runs ?? []
      const runs = new Map<string, Run>()
      for (const raw of list) {
        const r = slimRun(raw)
        if (r) {
          runs.set(r.id, r)
        }
      }
      w.runs.set(project, runs)
      w.projectErrors.delete(project)
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        throw e
      }
      w.projectErrors.set(project, (e as Error).message)
    }
    dirty()
  }

  /** Reads one project's event stream until it ends, then reloads the project and reconnects. */
  async function stream(w: Watch, project: string, signal: AbortSignal): Promise<void> {
    let failures = 0
    while (!signal.aborted) {
      const opened = Date.now()
      try {
        const res = await request(w, `${pathOf(project)}/events`, { accept: 'text/event-stream', signal })
        w.streaming.add(project)
        dirty()
        const decoder = new TextDecoder()
        let buf = ''
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
          let end: number
          while ((end = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, end)
            buf = buf.slice(end + 2)
            onEvent(w, project, block)
          }
        }
      } catch (e) {
        if (signal.aborted) {
          break
        }
        orca.log(`${w.host}/${project} events: ${(e as Error).message}`)
      }
      w.streaming.delete(project)
      dirty()
      if (signal.aborted) {
        break
      }
      // A stream that lasted a minute was healthy: start the backoff again.
      failures = Date.now() - opened > 60_000 ? 0 : failures + 1
      await sleep(RETRY_MS[Math.min(failures, RETRY_MS.length - 1)], signal)
      if (!signal.aborted) {
        // Whatever changed while the stream was down is only in the full list.
        await loadProject(w, project).catch((e: Error) => orca.log(`${w.host}/${project}: ${e.message}`))
      }
    }
  }

  function onEvent(w: Watch, project: string, block: string): void {
    const event = block.match(/^event: ?(.*)$/m)?.[1]?.trim()
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n')
    if (event === 'run-deleted') {
      // The cockpit page drops the run from its list on this event; so do we.
      let id: unknown
      try {
        id = (JSON.parse(data) as { id?: unknown }).id
      } catch {
        return
      }
      if (typeof id === 'string' && w.runs.get(project)?.delete(id)) {
        dirty()
      }
      return
    }
    if (event !== 'run') {
      return // ping, usage (CPU and memory of live runs), todos
    }
    let run: Run | undefined
    try {
      run = slimRun(JSON.parse(data))
    } catch {
      return
    }
    if (!run) {
      return
    }
    let runs = w.runs.get(project)
    if (!runs) {
      runs = new Map()
      w.runs.set(project, runs)
    }
    runs.set(run.id, { ...runs.get(run.id), ...run })
    dirty()
  }

  function openStreams(w: Watch): void {
    for (const project of watchedOf(w)) {
      if (life.signal.aborted || !watches.includes(w)) {
        return
      }
      if (!w.available.includes(project) || w.streams.has(project)) {
        continue
      }
      const ctl = new AbortController()
      life.signal.addEventListener('abort', () => ctl.abort())
      w.streams.set(project, ctl)
      void stream(w, project, ctl.signal)
    }
  }

  /** Reads the cockpit's projects and the full run list of each watched one, then streams. */
  async function load(w: Watch): Promise<void> {
    clearTimeout(w.retry)
    loading++
    void publish()
    try {
      const { projects } = await json<{ projects: { id: string; repoUrl?: string }[] }>(w, '/projects')
      w.available = projects.map((p) => p.id)
      w.repos = new Map(projects.filter((p) => p.repoUrl).map((p) => [p.id, String(p.repoUrl)]))
      for (const project of watchedOf(w)) {
        if (w.available.includes(project)) {
          await loadProject(w, project)
        }
      }
      w.error = undefined
      w.attempts = 0
      openStreams(w)
    } catch (e) {
      w.error = (e as Error).message
      orca.log(`${w.host}: ${w.error}`)
      if (life.signal.aborted || !watches.includes(w)) {
        return
      }
      const wait = RETRY_MS[Math.min(w.attempts++, RETRY_MS.length - 1)] * 2
      w.retry = setTimeout(() => void load(w), wait)
    } finally {
      loading--
      dirty()
    }
  }

  function dropWatch(w: Watch): void {
    clearTimeout(w.retry)
    for (const ctl of w.streams.values()) {
      ctl.abort()
    }
  }

  async function start(): Promise<void> {
    const mine = ++generation
    const cfg = await readSettings()
    if (mine !== generation || life.signal.aborted) {
      return
    }
    watches.forEach(dropWatch)
    watches = cfg.cockpits.map((c) => ({
      cfg: c,
      host: new URL(c.url).hostname,
      credsLoaded: false,
      available: [],
      repos: new Map(),
      runs: new Map(),
      projectErrors: new Map(),
      streams: new Map(),
      streaming: new Set(),
      attempts: 0
    }))
    clearInterval(fullTimer)
    fullTimer = setInterval(() => void refreshAll(), cfg.fullRefreshMinutes * 60_000)
    await Promise.all(watches.map(load))
  }

  async function refreshAll(): Promise<void> {
    await Promise.all(watches.map(load))
    await recompute()
  }

  // ---- snapshot, notifications, status bar -----------------------------------------------

  function dirty(): void {
    if (life.signal.aborted) {
      return
    }
    clearTimeout(dirtyTimer)
    dirtyTimer = setTimeout(() => void recompute(), 400)
  }

  async function build(cfg: Settings): Promise<Snapshot> {
    const now = Date.now()
    const cockpits: CockpitSnapshot[] = watches.map((w) => {
      const projects: ProjectSnapshot[] = watchedOf(w).map((project) => {
        if (w.available.length && !w.available.includes(project)) {
          return { project, ok: false, error: 'kokpit nie ma takiego projektu', live: [], problems: [], doneInWindow: 0 }
        }
        const error = w.projectErrors.get(project)
        if (error) {
          return { project, ok: false, error, live: [], problems: [], doneInWindow: 0 }
        }
        const runs = [...(w.runs.get(project)?.values() ?? [])]
        const s = summarize(runs, { cockpit: w.cfg.url, project, now, windowHours: cfg.windowHours, reasons })
        const repo = w.repos.get(project)
        const titled = <T extends { issueUrl?: string | null; mrUrl?: string | null }>(x: T): T => {
          // Without the forge's CLI: Cezar's own title, and no link to that forge.
          const issueUrl = linkable(x.issueUrl) ? x.issueUrl : null
          const mrUrl = linkable(x.mrUrl) ? x.mrUrl : null
          return {
            ...x,
            issueUrl,
            mrUrl,
            issueTitle: issueUrl ? (titles[issueUrl]?.title ?? null) : null,
            mrTitle: mrUrl ? (titles[mrUrl]?.title ?? null) : null
          }
        }
        return {
          ...s,
          live: s.live.map((x) => titled(keepOwnForge(x, repo))),
          problems: s.problems.map((x) => titled(keepOwnForge(x, repo)))
        }
      })
      return {
        url: w.cfg.url,
        host: w.host,
        ...(w.error ? { error: w.error } : {}), // storage takes JSON only: no undefined values
        available: w.available,
        watched: w.cfg.projects,
        credentialSource: w.creds?.source ?? null,
        streaming: projects.length > 0 && projects.every((p) => !p.ok || w.streaming.has(p.project)),
        projects
      }
    })
    return { at: now, cockpits }
  }

  /** Reads, once per failed run, why it stopped (the failed gate's output in its history). */
  async function readReasons(snap: Snapshot): Promise<boolean> {
    let read = false
    for (const w of watches) {
      const c = snap.cockpits.find((x) => x.url === w.cfg.url)
      for (const p of c?.projects ?? []) {
        const runs = [...(w.runs.get(p.project)?.values() ?? [])]
        for (const r of reasonsToRead(runs, p, reasons).slice(0, 5)) {
          try {
            const h = await json<{ events?: HistoryEvent[] }>(w, `${pathOf(p.project)}/runs/${r.id}/history`)
            reasons[r.id] = failureReason(r, h.events ?? [])
          } catch (e) {
            orca.log(`history ${p.project}/${r.id.slice(0, 8)}: ${(e as Error).message}`)
            reasons[r.id] = r.error ?? 'failed'
          }
          read = true
        }
      }
    }
    return read
  }

  /** Reads the titles of the issues and MRs the snapshot links to and does not know yet. */
  async function readTitles(snap: Snapshot): Promise<boolean> {
    const now = Date.now()
    const urls = new Set(
      snap.cockpits.flatMap((c) =>
        c.projects.flatMap((p) => [...p.live, ...p.problems].flatMap((x) => [x.issueUrl, x.mrUrl]))
      )
    )
    const stale = (u: string) => !titles[u] || (titles[u].title === null && now - titles[u].at > 3_600_000)
    // Only links shown (their forge's CLI is installed) that a CLI can read.
    const missing = [...urls].filter((u): u is string => Boolean(u) && Boolean(parseRef(u)) && stale(u as string))
    for (const url of missing.slice(0, 10)) {
      titles[url] = { title: await fetchTitle(parseRef(url)!), at: Date.now() }
    }
    if (missing.length) {
      // Keep what is linked now, plus a day of the rest, so the cache does not grow for ever.
      titles = Object.fromEntries(Object.entries(titles).filter(([u, t]) => urls.has(u) || now - t.at < 86_400_000))
      await orca.storage.set('titles', titles)
    }
    return missing.length > 0
  }

  let recomputing: Promise<void> | undefined
  let again = false
  async function recompute(): Promise<void> {
    if (recomputing) {
      again = true
      return recomputing
    }
    recomputing = (async () => {
      do {
        again = false
        const cfg = await readSettings()
        let snap = await build(cfg)
        const newTitles = await readTitles(snap)
        if (newTitles) {
          snap = await build(cfg)
        }
        if (await readReasons(snap)) {
          snap = await build(cfg)
          const keep = new Set(snap.cockpits.flatMap((c) => c.projects.flatMap((p) => p.problems.map((x) => x.runId))))
          reasons = Object.fromEntries(Object.entries(reasons).filter(([id]) => keep.has(id)))
          await orca.storage.set('reasons', reasons)
        }
        if (!loading) {
          await notify(cfg, snap)
        }
        await orca.storage.set('snapshot', snap)
        await publish()
      } while (again)
    })().finally(() => {
      recomputing = undefined
    })
    return recomputing
  }

  /** The stored snapshot, or null when it is missing or from an older version of the plugin. */
  async function storedSnapshot(): Promise<Snapshot | null> {
    const s = (await orca.storage.get('snapshot')) as Snapshot | null
    return s && Array.isArray(s.cockpits) ? s : null
  }

  async function state(): Promise<MonitorState> {
    const cfg = await readSettings()
    return {
      snapshot: await storedSnapshot(),
      dismissed: strings(await orca.storage.get('dismissed')),
      loading: loading > 0,
      fullRefreshMinutes: cfg.fullRefreshMinutes,
      clis: { ...clis }
    }
  }

  async function publish(): Promise<MonitorState> {
    const s = await state()
    orca.panels.post('cezar.state', s)
    await updateStatusBar(s)
    return s
  }

  async function updateStatusBar(s: MonitorState): Promise<void> {
    const snap = s.snapshot
    let text = 'Cezar'
    let tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' = 'neutral'
    let tooltip = 'Cezar - ładuję'
    if (snap && snap.cockpits.length && snap.cockpits.every((c) => c.error)) {
      text = 'Cezar ⚠️'
      tone = 'warning'
      tooltip = snap.cockpits.map((c) => `${c.host}: ${c.error}`).join('\n')
    } else if (snap) {
      const c = counts(snap, new Set(s.dismissed))
      text = `Cezar${c.problems ? ` 🔴 ${c.problems}` : ''}${c.live ? ` 🟢 ${c.live}` : ''}`
      tone = c.problems ? 'danger' : c.live ? 'success' : 'neutral'
      tooltip = snap.cockpits
        .flatMap((k) => [
          ...(snap.cockpits.length > 1 || k.error ? [`${k.host}${k.error ? ` - ${k.error}` : ''}`] : []),
          ...k.projects.map((p) => `${p.project}: ${p.ok ? `${p.live.length} w toku, ${p.problems.length} problemów` : `błąd - ${p.error}`}`)
        ])
        .join('\n')
    }
    try {
      await orca.host.call('statusBar.update', { id: STATUS_ITEM, text, tone, tooltip, icon: 'bot' })
    } catch (e) {
      orca.log(`statusBar.update: ${(e as Error).message}`)
    }
  }

  async function notify(cfg: Settings, snap: Snapshot): Promise<void> {
    const keys = snap.cockpits.flatMap((c) => c.projects.flatMap((p) => p.problems.map((x) => x.key)))
    const before = await orca.storage.get('notified')
    if (before === null) {
      // First look ever: what is already broken is not news.
      await orca.storage.set('notified', keys)
      return
    }
    const fresh = newProblems(snap, new Set(strings(before))).filter((p) => NOTIFY_KINDS.has(p.kind))
    // Remember only what still exists, so the list never grows without bound; a project that
    // could not be read keeps its old keys, so a reconnect does not notify everything again.
    const unreadable = snap.cockpits.some((c) => c.error || c.projects.some((p) => !p.ok))
    await orca.storage.set('notified', [...new Set(unreadable ? [...strings(before), ...keys] : keys)])
    if (!cfg.notify || !fresh.length) {
      return
    }
    const label: Record<Problem['kind'], string> = {
      failed: 'nie powiódł się',
      waiting: 'czeka na odpowiedź',
      held: 'wstrzymany limitem',
      retrying: 'ponawia bramkę',
      attention: 'wymaga uwagi'
    }
    const show = (title: string, body: string) =>
      orca.host.call('notifications.show', { title, body }).catch((e: Error) => orca.log(`notification: ${e.message}`))
    if (fresh.length > 3) {
      await show(`Cezar: ${fresh.length} nowe problemy`, fresh.map((p) => `${p.title} - ${label[p.kind]}`).join('\n'))
      return
    }
    for (const p of fresh) {
      await show(`Cezar: ${p.title.slice(0, 80)} ${label[p.kind]}`, p.detail.slice(0, 300))
    }
  }

  // ---- panel requests ---------------------------------------------------------------------

  async function writeCockpits(change: (list: CockpitConfig[]) => CockpitConfig[]): Promise<void> {
    const cfg = await readSettings()
    await orca.settings.set('cockpits', formatCockpits(change(cfg.cockpits))) // onDidChange restarts
  }

  orca.panels.handle('cezar.get', () => state())
  orca.panels.handle('cezar.refresh', async () => {
    await refreshAll()
    return state()
  })
  orca.panels.handle('cezar.dismiss', async ({ keys }) => {
    const snap = await storedSnapshot()
    const existing = new Set(snap?.cockpits.flatMap((c) => c.projects.flatMap((p) => p.problems.map((x) => x.key))) ?? [])
    const all = new Set([...strings(await orca.storage.get('dismissed')), ...keys])
    await orca.storage.set('dismissed', [...all].filter((k) => existing.has(k)))
    return publish()
  })
  orca.panels.handle('cezar.setProjects', async ({ cockpit, projects }) => {
    await writeCockpits((list) => list.map((c) => (c.url === cockpit ? { ...c, projects } : c)))
    return state()
  })
  orca.panels.handle('cezar.addCockpit', async ({ url }) => {
    const [parsed] = parseCockpits(url)
    if (!parsed) {
      throw Object.assign(new Error(`to nie jest adres kokpitu: ${url}`), { code: 'invalid_params' })
    }
    await writeCockpits((list) => (list.some((c) => c.url === parsed.url) ? list : [...list, parsed]))
    return state()
  })
  orca.panels.handle('cezar.removeCockpit', async ({ url }) => {
    await writeCockpits((list) => list.filter((c) => c.url !== url))
    return state()
  })
  orca.panels.handle('cezar.setLogin', async ({ cockpit, login, password }) => {
    const host = new URL(cockpit).hostname
    await orca.secrets.set(`login:${host}`, login.trim())
    await orca.secrets.set(`password:${host}`, password)
    const w = watches.find((x) => x.host === host)
    if (w) {
      w.credsLoaded = false
      await load(w)
    }
    return state()
  })
  orca.commands.register('cezar.refresh', async () => {
    await refreshAll()
    return 'Cezar odświeżony'
  })

  // A change in Settings (cockpits, projects, intervals) takes effect at once.
  orca.settings.onDidChange(() => void start())

  stop = () => {
    process.off('unhandledRejection', onStray)
    process.off('uncaughtException', onStray)
    life.abort()
    watches.forEach(dropWatch)
    clearInterval(fullTimer)
    clearInterval(tickTimer)
    clearTimeout(dirtyTimer)
  }

  void (async () => {
    reasons = ((await orca.storage.get('reasons')) as Record<string, string> | null) ?? {}
    titles = ((await orca.storage.get('titles')) as typeof titles | null) ?? {}
    // Never hold the start on it: the panel shows Cezar's titles until glab answers.
    for (const f of ['gitlab', 'github'] as const) {
      void cliAvailable(f).then((ok) => {
        clis[f] = ok
        dirty()
      })
    }
    // The window of failures and the "resumes at" of holds move with the clock, not with events.
    tickTimer = setInterval(dirty, 60_000)
    await start()
  })()
}

export function deactivate(): void {
  stop?.()
}
