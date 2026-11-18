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
  Tab,
  Tabs,
  Text,
  update,
  type OrcaNode,
  type PanelContext,
  type Tone,
} from 'orca'
import {
  projectCounts,
  refLabel,
  type CockpitSnapshot,
  type LiveRun,
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

/** One task: a coloured dot, the title as a link to the run in the cockpit, then the links to its
 *  issue and merge request and one line of detail. */
function Entry({
  tone,
  title,
  url,
  meta,
  issueUrl,
  mrUrl,
  issueNumber,
  project,
  issueTitle,
  mrTitle,
  summary,
}: {
  project: string
  issueTitle?: string | null
  mrTitle?: string | null
  summary?: string
  tone: Tone
  title: string
  url: string
  meta: string
  issueUrl?: string | null
  mrUrl?: string | null
  issueNumber?: number | null
}) {
  const issue = refLabel(issueUrl, issueNumber, project)
  const mr = refLabel(mrUrl, null, project)
  // The issue's (or MR's) own title says what the run is about; Cezar's summary says what it does.
  const heading = issueTitle ?? mrTitle ?? title
  const detail = heading !== title && summary ? `${summary} · ${meta}` : meta
  const hasLinks = Boolean((issue && issueUrl) || (mr && mrUrl))
  // The whole row (dot, title, detail) is one press target that opens the run. Orca allows no
  // pressable control inside a ListItem, so the issue and MR links sit just under it.
  return (
    <Stack gap="none">
      <List label={heading}>
        <ListItem onPress={() => open(url)}>
          <Box direction="row" gap="xs" align="start">
            <Box shrink={false}>
              <Text tone={tone} size="sm">
                ●
              </Text>
            </Box>
            <Box grow minWidth={0}>
              <Stack gap="none">
                <Text size="sm">{heading}</Text>
                <Text size="xs" muted truncate>
                  {detail}
                </Text>
              </Stack>
            </Box>
          </Box>
        </ListItem>
      </List>
      {hasLinks ? (
        <Box paddingX="lg">
          <Row gap="sm" wrap>
            {issue && issueUrl ? (
              <Text size="xs">
                <Link onPress={() => open(issueUrl)}>{`📋 ${issue}`}</Link>
              </Text>
            ) : null}
            {mr && mrUrl ? (
              <Text size="xs">
                <Link onPress={() => open(mrUrl)}>{`🔀 ${mr}`}</Link>
              </Text>
            ) : null}
          </Row>
        </Box>
      ) : null}
    </Stack>
  )
}

function runMeta(run: LiveRun): string {
  const since = run.startedAt != null ? `od ${clock(run.startedAt)}` : ''
  const parts =
    run.status === 'queued'
      ? ['w kolejce', run.workflow]
      : run.status === 'waiting'
        ? ['czeka na odpowiedź', run.step, since]
        : [`${run.step}${run.attempt > 1 ? ` (próba ${run.attempt})` : ''}`, since]
  return parts.filter(Boolean).join(' · ')
}

/** The project's counters as the same coloured dots the task rows use: red problems, green
 *  running, yellow waiting for an answer, grey queued. */
function Counters({ p, problems }: { p: ProjectSnapshot; problems: number }) {
  if (!p.ok) {
    return (
      <Text size="sm" tone="danger">
        ● błąd odczytu
      </Text>
    )
  }
  const n = (status: LiveRun['status']) => p.live.filter((r) => r.status === status).length
  const parts: [Tone, number][] = [
    ['danger', problems],
    ['success', n('running')],
    ['warning', n('waiting')],
    ['neutral', n('queued')],
  ]
  return (
    <Row gap="sm">
      {parts
        .filter(([, k]) => k > 0)
        .map(([tone, k]) => (
          <Text size="sm">
            <Text tone={tone}>●</Text>
            {` ${k}`}
          </Text>
        ))}
    </Row>
  )
}

function GroupLabel({ text, action }: { text: string; action?: OrcaNode }) {
  return (
    <Row justify="between">
      <Text size="xs" muted weight="semibold">
        {text}
      </Text>
      {action ?? null}
    </Row>
  )
}

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
  const tone: Tone | undefined = !p.ok || c.problems ? 'danger' : c.live ? 'success' : undefined
  const key = `${cockpit.host}/${p.project}`
  const isOpen = read(opened)[key] ?? Boolean(c.problems || c.live)
  const problems = p.problems.filter((x) => !dismissed.has(x.key))
  const toggle = () => update(opened, (o) => ({ ...o, [key]: !isOpen }))
  return (
    <Box background={tone ?? 'none'} border={tone ?? 'neutral'} radius="md" paddingX="sm" paddingY="xs">
      <List label={p.project}>
        <ListItem icon={isOpen ? 'collapse' : 'expand'} onPress={toggle}>
          <Row gap="sm">
            <Text size="sm" weight="semibold">
              {p.project}
            </Text>
            <Counters p={p} problems={c.problems} />
          </Row>
        </ListItem>
      </List>
      {isOpen ? (
        <Box paddingX="sm" paddingY="xs">
          <Stack gap="sm">
            {!p.ok ? (
              <Text size="xs" tone="danger">
                {p.error}
              </Text>
            ) : null}
            {problems.length ? (
              <Stack gap="none">
                <GroupLabel
                  text={`Problemy · ${problems.length}`}
                  action={
                    <IconButton
                      icon="check"
                      label="Oznacz jako przejrzane"
                      size="xs"
                      variant="ghost"
                      onPress={() => call(plugin.request('cezar.dismiss', { keys: problems.map((x) => x.key) }))}
                    />
                  }
                />
                {problems.map((x) => (
                  <Entry
                    project={p.project}
                    tone={PROBLEM_TONE[x.kind]}
                    title={x.title}
                    url={x.url}
                    issueUrl={x.issueUrl}
                    mrUrl={x.mrUrl}
                    issueNumber={x.issueNumber}
                    issueTitle={x.issueTitle}
                    mrTitle={x.mrTitle}
                    summary={x.summary}
                    meta={[PROBLEM_LABEL[x.kind], clock(x.at), x.detail].filter(Boolean).join(' · ')}
                  />
                ))}
              </Stack>
            ) : null}
            {p.live.length ? (
              <Stack gap="none">
                <GroupLabel text={`W toku · ${p.live.length}`} />
                {p.live.map((run) => (
                  <Entry
                    project={p.project}
                    tone={RUN_DOT[run.status]}
                    title={run.title}
                    url={run.url}
                    meta={runMeta(run)}
                    issueUrl={run.issueUrl}
                    mrUrl={run.mrUrl}
                    issueNumber={run.issueNumber}
                    issueTitle={run.issueTitle}
                    mrTitle={run.mrTitle}
                    summary={run.summary}
                  />
                ))}
              </Stack>
            ) : null}
            {p.ok && !problems.length && !p.live.length ? (
              <Text size="xs" muted>
                {p.doneInWindow ? `Nic nie leci · ${p.doneInWindow} ukończonych w oknie` : 'Nic nie leci'}
              </Text>
            ) : null}
          </Stack>
        </Box>
      ) : null}
    </Box>
  )
}

function CockpitNode({ c, many, dismissed }: { c: CockpitSnapshot; many: boolean; dismissed: Set<string> }) {
  return (
    <Stack gap="xs">
      <Row justify="between">
        <Text size="xs" muted weight="semibold" tone={c.error ? 'danger' : undefined} truncate>
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
  return (
    <Stack gap="sm">
      {err ? (
        <Text size="xs" tone="danger">
          {err}
        </Text>
      ) : null}
      <Tabs label="Widok" value={read(tab)} onChange={(v) => set(tab, v)}>
        <Tab value="projects" label="Projekty" icon="activity">
          <Stack gap="sm">
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
              </Row>
            </Row>
            {cockpits.length ? (
              cockpits.map((c) => <CockpitNode c={c} many={cockpits.length > 1} dismissed={dismissed} />)
            ) : (
              <EmptyState
                title="Brak kokpitu"
                description="Dodaj adres kokpitu Cezar w zakładce Ustawienia."
                icon="cloud"
              />
            )}
          </Stack>
        </Tab>
        <Tab value="settings" label="Ustawienia" icon="settings">
          <Settings s={s} />
        </Tab>
      </Tabs>
    </Stack>
  )
}
