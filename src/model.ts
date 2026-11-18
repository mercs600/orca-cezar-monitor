// Pure logic: what a project's runs mean for the panel and the status bar. No Orca, no network,
// so src/model.test.ts runs it on plain fixtures.

export type Step = {
  id: string
  name?: string
  kind?: string
  status: string
  iterations?: number
  startedAt?: string
  finishedAt?: string
}

/** The fields of a Cezar run (GET /api/v1/p/<project>/runs) the monitor reads. */
export type Run = {
  id: string
  title?: string
  titleSummary?: string
  workflow?: string
  status: string
  createdAt?: string
  startedAt?: string
  finishedAt?: string
  issueNumber?: number | null
  prNumber?: number | null
  pullRequestUrl?: string | null
  referencedIssueUrl?: string | null
  currentStepId?: string | null
  error?: string | null
  autoResumeAt?: string | null
  archived?: boolean
  steps?: Step[]
  worktreeLifecycle?: { needsAttention?: boolean; phase?: string; state?: string } | null
}

export type LiveRun = {
  id: string
  title: string
  workflow: string
  status: 'running' | 'waiting' | 'queued'
  step: string
  /** Attempts of the current step; above 1 means it is being retried. */
  attempt: number
  startedAt: number | null
  issueNumber: number | null
  prNumber: number | null
  url: string
  /** The issue or work item the run works on, and the merge request it opened, when known. */
  issueUrl?: string | null
  mrUrl?: string | null
  /** Titles of that issue and merge request, from GitLab. */
  issueTitle?: string | null
  mrTitle?: string | null
  /** Cezar's own short summary of the run, without the leading issue number. */
  summary?: string
}

export type ProblemKind = 'failed' | 'held' | 'retrying' | 'waiting' | 'attention'

export type Problem = {
  /** Stable per run and kind, so a dismissal and a notification happen once. */
  key: string
  runId: string
  kind: ProblemKind
  title: string
  detail: string
  at: number | null
  issueNumber: number | null
  prNumber: number | null
  url: string
  issueUrl?: string | null
  mrUrl?: string | null
  /** Titles of that issue and merge request, from GitLab. */
  issueTitle?: string | null
  mrTitle?: string | null
  /** Cezar's own short summary of the run, without the leading issue number. */
  summary?: string
}

export type ProjectSnapshot = {
  project: string
  ok: boolean
  /** Why the project could not be read; set when ok is false. */
  error?: string
  live: LiveRun[]
  problems: Problem[]
  doneInWindow: number
}

export type CockpitSnapshot = {
  url: string
  host: string
  /** The cockpit as a whole could not be read (credentials, VPN). */
  error?: string
  /** Projects the cockpit has; empty until it answered once. */
  available: string[]
  /** Projects named in the settings; empty = every project. */
  watched: string[]
  /** Where the login came from, or null when none was found. */
  credentialSource: string | null
  /** Live updates are streaming (server-sent events) for every watched project. */
  streaming: boolean
  projects: ProjectSnapshot[]
}

export type Snapshot = {
  at: number
  cockpits: CockpitSnapshot[]
}

const LIVE = new Set(['running', 'waiting', 'queued'])
// A gate prints its passing checks too, so a failure is read from the failure markers only
// (the rule Cezar's own gate scripts follow).
const FAIL_MARK = /✘|⛔|BLOCK|STOP|FAIL/

const ms = (ts: string | null | undefined): number | null => {
  if (!ts) {
    return null
  }
  const t = Date.parse(ts)
  return Number.isNaN(t) ? null : t
}

export const runTitle = (r: Run): string => {
  const text = (r.titleSummary || r.title || r.workflow || r.id.slice(0, 8)).trim()
  return r.issueNumber != null && !text.startsWith(`${r.issueNumber}`) ? `#${r.issueNumber} ${text}` : text
}

export const runLink = (cockpit: string, project: string, id: string): string =>
  `${cockpit.replace(/\/+$/, '')}/p/${encodeURIComponent(project)}/tasks/${id}`

/** The step a live run is on: the cockpit's own pointer, else the step marked running. */
export function currentStep(r: Run): Step | undefined {
  const steps = r.steps ?? []
  return (
    (r.currentStepId ? steps.find((s) => s.id === r.currentStepId) : undefined) ??
    steps.find((s) => s.status === 'running') ??
    steps.filter((s) => s.status !== 'pending').at(-1)
  )
}

/** The step a failed run stopped on. */
export function failedStep(r: Run): string | undefined {
  const failed = (r.steps ?? []).filter((s) => s.status === 'failed').at(-1)?.id
  return failed ?? String(r.error ?? '').match(/check "([^"]+)"/)?.[1] ?? undefined
}

const plain = (text: string): string[] =>
  text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

/** The line that says why a gate failed: the first failure-marked line, else the last line. */
export function failureLine(text: string | null | undefined): string | undefined {
  const lines = plain(String(text ?? ''))
  return (lines.find((l) => FAIL_MARK.test(l)) ?? lines.at(-1))?.slice(0, 400)
}

export type HistoryEvent = { type: string; stepId?: string; exitCode?: number; text?: string; message?: string }

/** Why a failed run stopped, from its newest workflow events; falls back to `run.error`. */
export function failureReason(r: Run, events: HistoryEvent[]): string {
  const step = failedStep(r)
  const check = events
    .filter((e) => e.type === 'check-output' && (e.exitCode ?? 0) !== 0 && (!step || e.stepId === step))
    .at(-1)
  const fromCheck = check ? failureLine(check.text) : undefined
  const fromError = events.filter((e) => e.type === 'error' || e.type === 'session.error').at(-1)
  return fromCheck ?? (fromError ? failureLine(fromError.message ?? fromError.text) : undefined) ?? r.error ?? 'failed'
}

export type SummarizeOptions = {
  cockpit: string
  project: string
  now: number
  windowHours: number
  /** Failure reasons already read from run history, by run id. */
  reasons?: Record<string, string>
}

export function summarize(runs: Run[], o: SummarizeOptions): ProjectSnapshot {
  const since = o.now - o.windowHours * 3_600_000
  const link = (id: string) => runLink(o.cockpit, o.project, id)
  const live: LiveRun[] = []
  const problems: Problem[] = []
  let doneInWindow = 0

  for (const r of runs) {
    const base = {
      runId: r.id,
      title: runTitle(r),
      issueNumber: r.issueNumber ?? null,
      prNumber: r.prNumber ?? null,
      url: link(r.id),
      issueUrl: r.referencedIssueUrl ?? null,
      mrUrl: r.pullRequestUrl ?? null,
      summary: (r.titleSummary || r.title || r.workflow || '').replace(/^#?\d+:\s*/, '').trim()
    }
    if (LIVE.has(r.status)) {
      const step = currentStep(r)
      const attempt = step?.iterations ?? 1
      live.push({
        id: r.id,
        title: base.title,
        workflow: r.workflow ?? '',
        status: r.status as LiveRun['status'],
        step: step?.name ?? step?.id ?? '-',
        attempt,
        startedAt: ms(r.startedAt) ?? ms(r.createdAt),
        issueNumber: base.issueNumber,
        prNumber: base.prNumber,
        url: base.url,
        issueUrl: base.issueUrl,
        mrUrl: base.mrUrl,
        summary: base.summary
      })
      if (r.status === 'waiting') {
        problems.push({
          ...base,
          key: `${r.id}:waiting`,
          kind: 'waiting',
          detail: `czeka na odpowiedź - krok ${step?.id ?? '-'}`,
          at: ms(step?.startedAt) ?? ms(r.startedAt)
        })
      } else if (attempt > 1 && step?.kind === 'check') {
        problems.push({
          ...base,
          key: `${r.id}:retry:${step.id}:${attempt}`,
          kind: 'retrying',
          detail: `bramka ${step.id} - próba ${attempt}`,
          at: ms(step.startedAt)
        })
      }
      continue
    }
    if (r.archived) {
      continue
    }
    const finished = ms(r.finishedAt) ?? ms(r.startedAt) ?? ms(r.createdAt)
    if (r.status === 'failed' && r.autoResumeAt) {
      problems.push({
        ...base,
        key: `${r.id}:held`,
        kind: 'held',
        detail: `limit konta - wznowi się ${new Date(r.autoResumeAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`,
        at: finished
      })
      continue
    }
    if (finished == null || finished < since) {
      continue
    }
    if (r.status === 'done') {
      doneInWindow++
    }
    if (r.status === 'failed') {
      const step = failedStep(r)
      problems.push({
        ...base,
        key: `${r.id}:failed`,
        kind: 'failed',
        detail: `${step ? `${step}: ` : ''}${o.reasons?.[r.id] ?? r.error ?? 'failed'}`,
        at: finished
      })
    } else if (r.worktreeLifecycle?.needsAttention) {
      problems.push({
        ...base,
        key: `${r.id}:attention`,
        kind: 'attention',
        detail: `worktree wymaga uwagi (${r.worktreeLifecycle.phase ?? '-'})`,
        at: finished
      })
    }
  }

  live.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  problems.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return { project: o.project, ok: true, live, problems, doneInWindow }
}

/** Failed runs in the snapshot whose reason has not been read from history yet. */
export const reasonsToRead = (runs: Run[], s: ProjectSnapshot, known: Record<string, string>): Run[] =>
  s.problems
    .filter((p) => p.kind === 'failed' && !(p.runId in known))
    .map((p) => runs.find((r) => r.id === p.runId))
    .filter((r): r is Run => Boolean(r))

export const allProjects = (s: Snapshot): ProjectSnapshot[] => s.cockpits.flatMap((c) => c.projects)

/** What changed since the last look and deserves a desktop notification. */
export function newProblems(s: Snapshot, notified: ReadonlySet<string>): Problem[] {
  return allProjects(s)
    .flatMap((p) => p.problems)
    .filter((p) => !notified.has(p.key) && p.kind !== 'attention')
}

export type Counts = { live: number; problems: number }

export function projectCounts(p: ProjectSnapshot, dismissed: ReadonlySet<string>): Counts {
  return { live: p.live.length, problems: p.problems.filter((x) => !dismissed.has(x.key)).length + (p.ok ? 0 : 1) }
}

export function counts(s: Snapshot, dismissed: ReadonlySet<string>): Counts {
  const each = allProjects(s).map((p) => projectCounts(p, dismissed))
  return {
    live: each.reduce((n, c) => n + c.live, 0),
    problems: each.reduce((n, c) => n + c.problems, 0) + s.cockpits.filter((c) => c.error).length
  }
}

/** A comma or whitespace separated project list. */
export const parseProjects = (value: unknown): string[] =>
  [...new Set(String(value ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))]

export type CockpitConfig = { url: string; projects: string[] }

/** The `cockpits` setting: one cockpit per line, `URL [project, project]`; no projects = all.
 *  Blank lines and `#` comments are skipped; a cockpit named twice keeps its first line. */
export function parseCockpits(value: unknown): CockpitConfig[] {
  const seen = new Set<string>()
  const out: CockpitConfig[] = []
  for (const raw of String(value ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) {
      continue
    }
    const [first, ...rest] = line.split(/\s+/)
    let url: URL
    try {
      url = new URL(first)
    } catch {
      continue
    }
    const key = url.origin
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push({ url: `${url.origin}${url.pathname}`.replace(/\/+$/, ''), projects: parseProjects(rest.join(' ')) })
  }
  return out
}

export const formatCockpits = (list: CockpitConfig[]): string =>
  list.map((c) => [c.url, c.projects.join(', ')].filter(Boolean).join(' ')).join('\n')

const RUN_FIELDS = [
  'id', 'title', 'titleSummary', 'workflow', 'status', 'createdAt', 'startedAt', 'finishedAt', 'issueNumber',
  'prNumber', 'pullRequestUrl', 'referencedIssueUrl', 'currentStepId', 'error', 'autoResumeAt', 'archived',
  'worktreeLifecycle'
] as const
const STEP_FIELDS = ['id', 'name', 'kind', 'status', 'iterations', 'startedAt', 'finishedAt'] as const

/** Only what the monitor reads: a run from the API carries its task, workflow and graph too
 *  (a busy project's list is several MB), and the worker keeps every run of every watched project. */
export function slimRun(raw: unknown): Run | undefined {
  if (!raw || typeof raw !== 'object' || typeof (raw as Run).id !== 'string') {
    return undefined
  }
  const r = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of RUN_FIELDS) {
    if (r[k] !== undefined) {
      out[k] = r[k]
    }
  }
  if (Array.isArray(r.steps)) {
    out.steps = r.steps.map((st: Record<string, unknown>) =>
      Object.fromEntries(STEP_FIELDS.filter((k) => st[k] !== undefined).map((k) => [k, st[k]]))
    )
  }
  return out as Run
}

/** A short label for a forge link: `#212` for an issue or work item (and a GitHub pull request),
 *  `!176` for a GitLab merge request;
 *  `module-x#1` when it lives in another repository than the project's own. */
export function refLabel(url: string | null | undefined, fallback?: number | null, project?: string): string | undefined {
  if (!url) {
    return undefined
  }
  const m = url.match(/\/([^/]+)\/(?:-\/)?(issues|work_items|merge_requests|pull)\/(\d+)/)
  if (!m) {
    return fallback != null ? `#${fallback}` : 'link'
  }
  const repo = project && m[1] !== project ? m[1] : ''
  // GitLab writes merge requests as !N; GitHub writes pull requests, like issues, as #N.
  return `${repo}${m[2] === 'merge_requests' ? '!' : '#'}${m[3]}`
}

const hostOf = (url: string | null | undefined): string | undefined => {
  try {
    return url ? new URL(url).host : undefined
  } catch {
    return undefined
  }
}

type Linked = { title: string; issueNumber: number | null; issueUrl?: string | null; mrUrl?: string | null }

/** Drops links to another forge than the project's own (Cezar sometimes picks an issue URL out of
 *  free text, e.g. a gitlab.com issue), with the issue number it put in the title. */
export function keepOwnForge<T extends Linked>(item: T, repoUrl: string | undefined): T {
  const own = hostOf(repoUrl)
  if (!own) {
    return item
  }
  const out = { ...item }
  if (out.issueUrl && hostOf(out.issueUrl) !== own) {
    if (out.issueNumber != null && out.title.startsWith(`#${out.issueNumber} `)) {
      out.title = out.title.slice(`#${out.issueNumber} `.length)
    }
    out.issueUrl = null
    out.issueNumber = null
  }
  if (out.mrUrl && hostOf(out.mrUrl) !== own) {
    out.mrUrl = null
  }
  return out
}
