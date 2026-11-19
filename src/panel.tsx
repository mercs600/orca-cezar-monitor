// No build step: Orca strips the types and compiles the JSX when the panel loads.
// A compact tree: cockpit → project (collapsible; red with problems, green while runs go) → runs.
import {
  atom,
  Box,
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  Input,
  Link,
  ListItem,
  List,
  plugin,
  read,
  Row,
  Select,
  set,
  shell,
  Spinner,
  Stack,
  Text,
  update,
  type PanelContext,
  type Tone,
} from 'orca'
import {
  duration,
  projectCounts,
  type Progress,
  type StepVisual,
  refLabel,
  type CockpitSnapshot,
  type LiveRun,
  type MrRef,
  type Problem,
  type ProjectSnapshot,
} from './model'
import type { MonitorState } from './protocol'

const state = atom<MonitorState | null>(null)
const failure = atom<string | null>(null)
/** Which project nodes the person opened or closed, by `host/project`; unset = automatic. */
const opened = atom<Record<string, boolean>>('opened', {}, { persist: 'plugin' })
const loginCockpit = atom('')
const login = atom('')
const password = atom('')
const newCockpit = atom('')
const tab = atom('view', 'projects', { persist: 'plugin' })
/** The run whose "explain" session is starting, by its link. */
const explaining = atom<string | null>(null)
/** What the last "explain" did: where the session opened, or why it did not. */
const notice = atom<{ tone: Tone; text: string } | null>(null)

async function explain(url: string, title: string): Promise<void> {
  set(explaining, url)
  try {
    const { workspace } = await plugin.request('cezar.explain', { url, title })
    set(notice, { tone: 'success', text: `Otwieram sesję w ${workspace}: ${title}` })
  } catch (e) {
    set(notice, { tone: 'danger', text: (e as Error).message })
  } finally {
    set(explaining, null)
  }
}

async function call(p: Promise<MonitorState>): Promise<void> {
  try {
    set(state, await p)
    set(failure, null)
  } catch (e) {
    set(failure, (e as Error).message)
  }
}

const open = (url: string) => void shell.openExternal(url)

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('cezar.state', (s) => set(state, s)))
  void call(plugin.request('cezar.get'))
}

/** A clock time, not a countdown: "14:32" today, "16.11 18:10" on another day. */
function clock(ms: number | null): string {
  if (ms == null) {
    return ''
  }
  const d = new Date(ms)
  const hm = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })} ${hm}`
}

const RUN_DOT: Record<LiveRun['status'], Tone> = { running: 'success', waiting: 'warning', queued: 'neutral' }
const PROBLEM_TONE: Record<Problem['kind'], Tone> = {
  failed: 'danger',
  held: 'warning',
  retrying: 'warning',
  waiting: 'warning',
  attention: 'warning',
}
const PROBLEM_LABEL: Record<Problem['kind'], string> = {
  failed: 'nieudany',
  held: 'limit konta',
  retrying: 'ponawia bramkę',
  waiting: 'czeka na odpowiedź',
  attention: 'worktree do uwagi',
}

/** One task, laid out like an entry of Orca's activity list: a status dot, the title (wrapping),
 *  the time on the right, a muted line of detail, then the issue and MR links as its footer. The
 *  row opens the run; Orca allows nothing pressable inside a ListItem, so the links sit under it. */
function Entry({
  tone,
  mark = '●',
  title,
  url,
  meta,
  time,
  issueUrl,
  mrUrl,
  issueNumber,
  prNumber,
  moreMrs = [],
  mrBranch,
  project,
  issueTitle,
  mrTitle,
  summary,
  progress,
}: {
  progress?: Progress | null
  tone: Tone
  /** The status mark: a dot, or ✓ for a finished run. */
  mark?: string
  title: string
  url: string
  meta: string
  time: string
  project: string
  issueUrl?: string | null
  mrUrl?: string | null
  issueNumber?: number | null
  /** The run's MR number, shown without a link when its URL is unknown. */
  prNumber?: number | null
  /** Other MRs the run touched after the main one: a security report, a changelog... */
  moreMrs?: MrRef[]
  /** The main MR's source branch: shown instead of `!3`, which says little. */
  mrBranch?: string | null
  issueTitle?: string | null
  mrTitle?: string | null
  summary?: string
}) {
  const issue = refLabel(issueUrl, issueNumber, project)
  const mr = refLabel(mrUrl, null, project)
  // The issue's (or MR's) own title says what the run is about; Cezar's summary says what it does.
  const heading = issueTitle ?? mrTitle ?? title
  const detail = (heading !== title && summary ? [summary, meta] : [meta]).filter(Boolean).join(' · ')
  const hasLinks = Boolean((issue && issueUrl) || (mr && mrUrl) || prNumber != null || moreMrs.length)
  return (
    <Stack gap="none">
      <List label={heading}>
        <ListItem onPress={() => open(url)}>
          <Box direction="row" gap="sm" align="start">
            <Box shrink={false}>
              <Text tone={tone} size="sm">
                {mark}
              </Text>
            </Box>
            <Box grow minWidth={0}>
              <Stack gap="none">
                <Box direction="row" gap="sm" align="start" justify="between">
                  <Box grow minWidth={0}>
                    <Text size="sm" weight="semibold">
                      {heading}
                    </Text>
                  </Box>
                  <Box shrink={false}>
                    <Text size="xs" muted>
                      {time}
                    </Text>
                  </Box>
                </Box>
                {progress ? <Steps progress={progress} /> : null}
                <Text size="xs" muted truncate>
                  {detail}
                </Text>
              </Stack>
            </Box>
          </Box>
        </ListItem>
      </List>
      {/* The footer starts under the title, as the branch line of an Orca activity entry does. */}
      <Box direction="row" align="center">
        <Box width={LINK_INDENT} shrink={false} />
        <Box grow minWidth={0}>
          {hasLinks ? (
            <Row gap="sm" wrap>
              {issue && issueUrl ? (
                <Text size="xs" muted>
                  <Link onPress={() => open(issueUrl)}>{`📋 ${issue}`}</Link>
                </Text>
              ) : null}
              {mr && mrUrl ? (
                <Text size="xs" muted>
                  <Link onPress={() => open(mrUrl)}>{`🔀 ${mrBranch ?? mr}`}</Link>
                </Text>
              ) : prNumber != null ? (
                // The run recorded the MR's number only and its repository is unknown: no link.
                <Text size="xs" muted>{`🔀 !${prNumber}`}</Text>
              ) : null}
              {moreMrs.map((m) =>
                m.url ? (
                  <Text size="xs" muted>
                    <Link onPress={() => open(m.url!)}>{`🔀 ${m.branch ?? refLabel(m.url, null, project)}`}</Link>
                  </Text>
                ) : m.number != null ? (
                  <Text size="xs" muted>{`🔀 !${m.number}`}</Text>
                ) : null
              )}
            </Row>
          ) : null}
        </Box>
        <Box shrink={false}>
          <Button
            size="xs"
            variant="ghost"
            icon="agent"
            tooltip="Nowa sesja agenta w workspace projektu wyjaśni, co się dzieje z tym runem"
            disabled={read(explaining) === url}
            onPress={() => explain(url, heading)}
          >
            Wyjaśnij
          </Button>
        </Box>
      </Box>
    </Stack>
  )
}

const STEP_TONE: Record<StepVisual, Tone | undefined> = {
  done: 'success',
  active: 'warning',
  failed: 'danger',
  pending: undefined,
}

/** The cockpit's step dots: one per workflow step, then "3/14" and the step's name. */
function Steps({ progress }: { progress: Progress }) {
  return (
    <Text size="xs" truncate>
      {progress.steps.map((v) =>
        STEP_TONE[v] ? (
          <Text size="xs" tone={STEP_TONE[v]}>
            ●
          </Text>
        ) : (
          <Text size="xs" muted>
            ●
          </Text>
        ),
      )}
      <Text size="xs" muted>{`  ${progress.at}/${progress.steps.length} · ${progress.name}`}</Text>
    </Text>
  )
}

/** Left offset of an entry's links, in pixels: the ListItem padding plus the status dot column. */
const LINK_INDENT = 28

function runMeta(run: LiveRun): string {
  const parts =
    run.status === 'queued'
      ? ['w kolejce', run.workflow]
      : run.status === 'waiting'
        ? ['czeka na odpowiedź', run.step]
        : [
            run.progress
              ? run.attempt > 1
                ? `próba ${run.attempt}`
                : ''
              : `${run.step}${run.attempt > 1 ? ` (próba ${run.attempt})` : ''}`,
          ]
  return parts.filter(Boolean).join(' · ')
}

/** The runs that ended in the window - done (✓) or cancelled - as a collapsed sub-group, newest
 *  first, at most FINISHED_SHOWN of them; the rest are a link away, in the cockpit. */
function Finished({ cockpit, p }: { cockpit: CockpitSnapshot; p: ProjectSnapshot }) {
  const finished = p.finished ?? []
  if (!finished.length) {
    return null
  }
  const key = `${cockpit.host}/${p.project}#finished`
  const isOpen = read(opened)[key] ?? false
  const total = p.finishedInWindow ?? finished.length
  return (
    <Stack gap="sm">
      <List label={`Zakończone - ${p.project}`}>
        <ListItem
          icon={isOpen ? 'collapse' : 'expand'}
          onPress={() => update(opened, (o) => ({ ...o, [key]: !isOpen }))}
        >
          <Text size="xs" muted weight="semibold">
            {`Zakończone · ${total}`}
          </Text>
        </ListItem>
      </List>
      {isOpen
        ? finished.map((r) => (
            <Entry
              project={p.project}
              mark={r.status === 'done' ? '✓' : '–'}
              tone={r.status === 'done' ? 'success' : 'neutral'}
              title={r.title}
              url={r.url}
              time={clock(r.finishedAt)}
              meta={[r.status === 'cancelled' ? 'anulowany' : '', duration(r.durationMs)].filter(Boolean).join(' · ')}
              issueUrl={r.issueUrl}
              mrUrl={r.mrUrl}
              issueNumber={r.issueNumber}
              prNumber={r.prNumber}
              moreMrs={r.moreMrs}
              mrBranch={r.mrBranch}
              issueTitle={r.issueTitle}
              mrTitle={r.mrTitle}
              summary={r.summary}
              progress={r.progress}
            />
          ))
        : null}
      {isOpen && total > finished.length ? (
        <Box paddingX="lg">
          <Text size="xs" muted>
            <Link onPress={() => open(`${cockpit.url}/p/${encodeURIComponent(p.project)}`)}>
              {`wszystkie (${total}) w kokpicie`}
            </Link>
          </Text>
        </Box>
      ) : null}
    </Stack>
  )
}

/** A project as a group of Orca's activity list: chevron, name in small capitals, a status dot,
 *  the task count on the right; its tasks under it, problems first. */
function ProjectNode({
  cockpit,
  p,
  dismissed,
}: {
  cockpit: CockpitSnapshot
  p: ProjectSnapshot
  dismissed: Set<string>
}) {
  const c = projectCounts(p, dismissed)
  const tone: Tone = !p.ok || c.problems ? 'danger' : c.live ? 'success' : 'neutral'
  const key = `${cockpit.host}/${p.project}`
  const isOpen = read(opened)[key] ?? Boolean(c.problems || c.live)
  const problems = p.problems.filter((x) => !dismissed.has(x.key))
  const total = problems.length + p.live.length
  return (
    <Stack gap="none">
      <Box direction="row" align="center" gap="xs">
        <Box grow minWidth={0}>
          <List label={p.project}>
            <ListItem
              icon={isOpen ? 'collapse' : 'expand'}
              onPress={() => update(opened, (o) => ({ ...o, [key]: !isOpen }))}
            >
              <Box direction="row" gap="sm" align="center" justify="between">
                <Row gap="xs">
                  <Text tone={tone} size="xs">
                    ●
                  </Text>
                  <Text size="xs" muted weight="semibold">
                    {p.project.toUpperCase()}
                  </Text>
                </Row>
                <Text size="xs" muted>
                  {!p.ok ? 'błąd' : String(total)}
                </Text>
              </Box>
            </ListItem>
          </List>
        </Box>
        {problems.length ? (
          <Box shrink={false}>
            <IconButton
              icon="check"
              label="Oznacz problemy jako przejrzane"
              size="xs"
              variant="ghost"
              onPress={() => call(plugin.request('cezar.dismiss', { keys: problems.map((x) => x.key) }))}
            />
          </Box>
        ) : null}
      </Box>
      {isOpen ? (
        <Stack gap="sm">
          {!p.ok ? (
            <Box paddingX="lg">
              <Text size="xs" tone="danger">
                {p.error}
              </Text>
            </Box>
          ) : null}
          {problems.map((x) => (
            <Entry
              project={p.project}
              tone={PROBLEM_TONE[x.kind]}
              title={x.title}
              url={x.url}
              time={clock(x.at)}
              meta={[PROBLEM_LABEL[x.kind], x.detail].filter(Boolean).join(' · ')}
              issueUrl={x.issueUrl}
              mrUrl={x.mrUrl}
              issueNumber={x.issueNumber}
              prNumber={x.prNumber}
              moreMrs={x.moreMrs}
              mrBranch={x.mrBranch}
              issueTitle={x.issueTitle}
              mrTitle={x.mrTitle}
              summary={x.summary}
              progress={x.progress}
            />
          ))}
          {p.live.map((run) => (
            <Entry
              project={p.project}
              tone={RUN_DOT[run.status]}
              title={run.title}
              url={run.url}
              time={clock(run.startedAt)}
              meta={runMeta(run)}
              issueUrl={run.issueUrl}
              mrUrl={run.mrUrl}
              issueNumber={run.issueNumber}
              prNumber={run.prNumber}
              moreMrs={run.moreMrs}
              mrBranch={run.mrBranch}
              issueTitle={run.issueTitle}
              mrTitle={run.mrTitle}
              summary={run.summary}
              progress={run.progress}
            />
          ))}
          {p.ok && !problems.length && !p.live.length ? (
            <Box paddingX="lg" paddingY="xs">
              <Text size="xs" muted>
                Nic nie leci
              </Text>
            </Box>
          ) : null}
          <Finished cockpit={cockpit} p={p} />
        </Stack>
      ) : null}
    </Stack>
  )
}

function CockpitNode({ c, dismissed }: { c: CockpitSnapshot; dismissed: Set<string> }) {
  return (
    <Stack gap="xs">
      <Row justify="between">
        <Text size="xs" muted tone={c.error ? 'danger' : undefined} truncate>
          {c.host}
        </Text>
        <IconButton
          icon="open-external"
          label={`Otwórz ${c.host}`}
          size="xs"
          variant="ghost"
          onPress={() => open(c.url)}
        />
      </Row>
      {c.error ? (
        <Text size="xs" tone="danger">
          {c.error}
        </Text>
      ) : null}
      {c.projects.map((p) => (
        <ProjectNode cockpit={c} p={p} dismissed={dismissed} />
      ))}
    </Stack>
  )
}

function Settings({ s }: { s: MonitorState }) {
  const cockpits = s.snapshot?.cockpits ?? []
  const target = cockpits.find((c) => c.url === read(loginCockpit)) ?? cockpits[0]
  return (
    <Stack gap="md">
      <Stack gap="md">
        {cockpits.map((c) => {
          const all = c.watched.length === 0
          const listed = [...new Set([...c.available, ...c.watched])]
          const toggle = (project: string, on: boolean) => {
            const current = all ? c.available : c.watched
            const next = on ? [...new Set([...current, project])] : current.filter((x) => x !== project)
            const everything = c.available.every((x) => next.includes(x))
            void call(plugin.request('cezar.setProjects', { cockpit: c.url, projects: everything ? [] : next }))
          }
          return (
            <Stack gap="xs">
              <Row justify="between">
                <Text size="xs" weight="semibold" truncate>{`${c.host} · login: ${c.credentialSource ?? 'brak'}`}</Text>
                {cockpits.length > 1 ? (
                  <IconButton
                    icon="delete"
                    label={`Usuń ${c.host}`}
                    size="xs"
                    variant="ghost"
                    onPress={() => call(plugin.request('cezar.removeCockpit', { url: c.url }))}
                  />
                ) : null}
              </Row>
              {listed.map((p) => (
                <Checkbox
                  label={p}
                  description={c.available.length && !c.available.includes(p) ? 'brak w kokpicie' : undefined}
                  checked={all || c.watched.includes(p)}
                  onChange={(on) => toggle(p, on)}
                />
              ))}
            </Stack>
          )
        })}
        <Stack gap="none">
          <Text muted size="xs">
            {s.clis?.gitlab
              ? 'glab: jest - tytuły i linki issue/MR z GitLaba.'
              : 'glab: brak - dla GitLaba tytuły z Cezara, bez linków.'}
          </Text>
          <Text muted size="xs">
            {s.clis?.github
              ? 'gh: jest - tytuły i linki issue/PR z GitHuba.'
              : 'gh: brak - dla GitHuba tytuły z Cezara, bez linków.'}
          </Text>
        </Stack>
        <Stack gap="xs">
          <Input
            label="Dodaj kokpit"
            placeholder="https://cezar.example.com:4443"
            value={read(newCockpit)}
            onChange={(v) => set(newCockpit, v)}
            onSubmit={async (v) => {
              await call(plugin.request('cezar.addCockpit', { url: v }))
              set(newCockpit, '')
            }}
          />
          <Text muted size="xs">
            Login: netrc (~/.config/cezar/netrc, ~/.netrc), keychain cezar:&lt;host&gt; albo zapisany niżej. Projekty
            wybierzesz, gdy kokpit odpowie.
          </Text>
        </Stack>
        {target ? (
          <Stack gap="xs">
            {cockpits.length > 1 ? (
              <Select
                label="Kokpit"
                value={target.url}
                options={cockpits.map((c) => ({ value: c.url, label: c.host }))}
                onChange={(v) => set(loginCockpit, v)}
              />
            ) : null}
            <Input label="Login" value={read(login)} onChange={(v) => set(login, v)} />
            <Input label="Hasło" type="password" value={read(password)} onChange={(v) => set(password, v)} />
            <Row>
              <Button
                size="xs"
                variant="outline"
                disabled={!read(login) || !read(password)}
                onPress={async () => {
                  await call(
                    plugin.request('cezar.setLogin', {
                      cockpit: target.url,
                      login: read(login),
                      password: read(password),
                    }),
                  )
                  set(password, '')
                }}
              >
                {`Zapisz login dla ${target.host}`}
              </Button>
            </Row>
          </Stack>
        ) : null}
      </Stack>
    </Stack>
  )
}

export default function Panel() {
  const s = read(state)
  const err = read(failure)
  if (!s) {
    return err ? <Text tone="danger">{`Worker nie odpowiada: ${err}`}</Text> : <Spinner label="Łączę z kokpitem" />
  }
  const snap = s.snapshot
  const dismissed = new Set(s.dismissed)
  const cockpits = snap?.cockpits ?? []
  const live = cockpits.every((c) => c.streaming)
  // No cockpit yet: open on the settings, where one is added.
  const settingsOpen = read(tab) === 'settings' || cockpits.length === 0
  return (
    <Stack gap="sm">
      {err ? (
        <Text size="xs" tone="danger">
          {err}
        </Text>
      ) : null}
      {read(notice) ? (
        <Row justify="between" align="start">
          <Text size="xs" tone={read(notice)!.tone}>
            {read(notice)!.text}
          </Text>
          <IconButton icon="close" label="Zamknij" size="xs" variant="ghost" onPress={() => set(notice, null)} />
        </Row>
      ) : null}
      {/* Like Orca's own sidebar modules: a header with icon actions, no tabs. */}
      <Row justify="between">
        <Text muted size="xs">
          <Text tone={live ? 'success' : 'warning'}>●</Text>
          {live ? ' na żywo' : ' łączę…'}
        </Text>
        <Row gap="xs">
          {s.loading ? <Spinner label="Ładuję" labelHidden /> : null}
          <IconButton
            icon="refresh"
            label="Przeładuj wszystko"
            size="xs"
            variant="ghost"
            onPress={() => call(plugin.request('cezar.refresh'))}
          />
          <IconButton
            icon={settingsOpen ? 'close' : 'settings'}
            label={settingsOpen ? 'Zamknij ustawienia' : 'Ustawienia'}
            size="xs"
            variant="ghost"
            onPress={() => set(tab, settingsOpen ? 'projects' : 'settings')}
          />
        </Row>
      </Row>
      {settingsOpen ? (
        <Settings s={s} />
      ) : cockpits.length ? (
        <Stack gap="md">
          {cockpits.map((c) => (
            <CockpitNode c={c} dismissed={dismissed} />
          ))}
        </Stack>
      ) : (
        <EmptyState title="Brak kokpitu" description="Dodaj adres kokpitu Cezar w ustawieniach (⚙)." icon="cloud" />
      )}
    </Stack>
  )
}
