import { forgeInfo, parseRef, titleCall } from './forge'
import { assert, test } from 'orca/testing'
import {
  counts,
  cockpitSkill,
  explainPrompt,
  explainRequest,
  skillMeta,
  parseRunLink,
  pickWorkspace,
  repoKey,
  type WorkspaceInfo,
  keepOwnForge,
  progressOf,
  mrUrlOf,
  mrsOf,
  duration,
  newlyDone,
  refLabel,
  failureLine,
  failureReason,
  formatCockpits,
  newProblems,
  parseCockpits,
  parseProjects,
  slimRun,
  summarize,
  type Run,
  type Snapshot,
} from './model'

const NOW = Date.parse('2026-11-17T12:00:00Z')
const o = { cockpit: 'https://c.example:4443/', project: 'app', now: NOW, windowHours: 24 }

const runs: Run[] = [
  {
    id: 'aaaaaaaa-live',
    titleSummary: 'refresh all states',
    issueNumber: 209,
    workflow: 'app-issue-to-mr',
    status: 'running',
    startedAt: '2026-11-17T11:00:00Z',
    steps: [
      { id: 'preflight', kind: 'check', status: 'done', iterations: 1 },
      {
        id: 'validate',
        name: 'Validation gate',
        kind: 'check',
        status: 'running',
        iterations: 3,
        startedAt: '2026-11-17T11:50:00Z',
      },
    ],
  },
  { id: 'bbbbbbbb-wait', title: 'q', status: 'waiting', steps: [{ id: 'ask', status: 'running', iterations: 1 }] },
  { id: 'cccccccc-queue', title: 'later', status: 'queued' },
  {
    id: 'dddddddd-fail',
    titleSummary: 'ui check',
    issueNumber: 250,
    status: 'failed',
    finishedAt: '2026-11-17T10:00:00Z',
    error: 'check "ui-check" failed',
    steps: [{ id: 'ui-check', status: 'failed' }],
  },
  { id: 'eeeeeeee-old', status: 'failed', finishedAt: '2026-11-15T10:00:00Z', error: 'old' },
  { id: 'ffffffff-arch', status: 'failed', finishedAt: '2026-11-17T10:00:00Z', archived: true },
  { id: 'gggggggg-held', status: 'failed', finishedAt: '2026-11-17T09:00:00Z', autoResumeAt: '2026-11-17T13:00:00Z' },
  { id: 'hhhhhhhh-done', status: 'done', finishedAt: '2026-11-17T08:00:00Z' },
]

test('live runs carry the current step, its attempt and a cockpit link', () => {
  const s = summarize(runs, o)
  assert.equal(s.live.length, 3)
  const run = s.live.find((r) => r.id === 'aaaaaaaa-live')
  assert.ok(run)
  assert.equal(run.title, '#209 refresh all states')
  assert.equal(run.step, 'Validation gate')
  assert.equal(run.attempt, 3)
  assert.equal(run.url, 'https://c.example:4443/p/app/tasks/aaaaaaaa-live')
})

test('problems: failed in the window, held, waiting and a retried gate - never archived or old', () => {
  const s = summarize(runs, o)
  const kinds = s.problems.map((p) => `${p.runId.slice(0, 8)}:${p.kind}`).sort()
  assert.deepEqual(kinds, ['aaaaaaaa:retrying', 'bbbbbbbb:waiting', 'dddddddd:failed', 'gggggggg:held'])
  assert.equal(s.doneInWindow, 1)
  const failed = s.problems.find((p) => p.kind === 'failed')
  assert.equal(failed?.detail, 'ui-check: check "ui-check" failed')
})

test('a reason read from history replaces the generic error', () => {
  const s = summarize(runs, { ...o, reasons: { 'dddddddd-fail': '✘ title differs' } })
  assert.equal(s.problems.find((p) => p.kind === 'failed')?.detail, 'ui-check: ✘ title differs')
})

test('failure line: the first failure-marked line, else the last line', () => {
  assert.equal(failureLine('✔ lint\n\x1b[31m✘ typecheck: 2 errors\x1b[0m\n✔ jest'), '✘ typecheck: 2 errors')
  assert.equal(failureLine('one\ntwo\n'), 'two')
  assert.equal(failureLine(''), undefined)
})

test('failure reason reads the failed step check output', () => {
  const run = runs[3]
  const reason = failureReason(run, [
    { type: 'check-output', stepId: 'preflight', exitCode: 1, text: '✘ other' },
    { type: 'check-output', stepId: 'ui-check', exitCode: 0, text: '✔ fine' },
    { type: 'check-output', stepId: 'ui-check', exitCode: 1, text: '✔ a\nFAIL heading order' },
  ])
  assert.equal(reason, 'FAIL heading order')
  assert.equal(failureReason(run, []), 'check "ui-check" failed')
})

test('counts skip dismissed problems; new problems skip notified ones', () => {
  const cockpit = { url: 'c', host: 'c', available: ['app'], watched: [], credentialSource: null, streaming: true }
  const snap: Snapshot = { at: NOW, cockpits: [{ ...cockpit, projects: [summarize(runs, o)] }] }
  assert.deepEqual(counts(snap, new Set(['dddddddd-fail:failed'])), { live: 3, problems: 3 })
  const fresh = newProblems(snap, new Set(['gggggggg-held:held']))
  assert.equal(
    fresh.some((p) => p.kind === 'held'),
    false,
  )
  assert.equal(
    fresh.some((p) => p.kind === 'failed'),
    true,
  )
})

test('projects setting parses commas and spaces, drops duplicates', () => {
  assert.deepEqual(parseProjects(' web-app, api api;x '), ['web-app', 'api', 'x'])
  assert.deepEqual(parseProjects(''), [])
})

test('cockpits setting: one per line, optional projects, comments and duplicates skipped', () => {
  const list = parseCockpits(`
    https://a.example:4443/  web-app, api
    # https://off.example
    https://b.example:4443
    https://a.example:4443 other
    not a url
  `)
  assert.deepEqual(list, [
    { url: 'https://a.example:4443', projects: ['web-app', 'api'] },
    { url: 'https://b.example:4443', projects: [] },
  ])
  assert.equal(formatCockpits(list), 'https://a.example:4443 web-app, api\nhttps://b.example:4443')
})

test('slim run keeps what the monitor reads and drops the heavy rest', () => {
  const r = slimRun({
    id: 'x',
    status: 'running',
    task: 'long',
    workflowDef: { big: true },
    steps: [{ id: 's', status: 'done', sessionId: 'q' }],
  })
  assert.deepEqual(r, { id: 'x', status: 'running', steps: [{ id: 's', status: 'done' }] })
  assert.equal(slimRun({ status: 'x' }), undefined)
})

test('issue and merge request links reach live runs and problems, with short labels', () => {
  const s = summarize(
    [
      {
        id: 'l',
        status: 'running',
        referencedIssueUrl: 'https://git.example/g/p/-/work_items/212',
        pullRequestUrl: 'https://git.example/g/p/-/merge_requests/176',
      },
      {
        id: 'f',
        status: 'failed',
        finishedAt: new Date(NOW).toISOString(),
        referencedIssueUrl: 'https://git.example/g/p/-/issues/9',
      },
    ],
    o,
  )
  assert.equal(s.live[0].issueUrl, 'https://git.example/g/p/-/work_items/212')
  assert.equal(s.live[0].mrUrl, 'https://git.example/g/p/-/merge_requests/176')
  assert.equal(s.problems[0].issueUrl, 'https://git.example/g/p/-/issues/9')
  assert.equal(refLabel(s.live[0].issueUrl), '#212')
  assert.equal(refLabel(s.live[0].mrUrl), '!176')
  assert.equal(refLabel('https://github.com/o/r/pull/5'), '#5')
  assert.equal(refLabel(null), undefined)
  assert.equal(refLabel('https://git.example/g/p/-/work_items/212', null, 'p'), '#212')
  assert.equal(refLabel('https://git.example/g/module-x/-/merge_requests/3', null, 'p'), 'module-x!3')
})

test('links to another forge are dropped with the issue number Cezar put in the title', () => {
  const item = {
    title: '#320761 updating lockfile',
    issueNumber: 320761,
    issueUrl: 'https://gitlab.com/gitlab-org/gitlab/-/issues/320761',
    mrUrl: 'https://git.example/g/api/-/merge_requests/458',
  }
  const kept = keepOwnForge(item, 'https://git.example/g/api')
  assert.equal(kept.issueUrl, null)
  assert.equal(kept.title, 'updating lockfile')
  assert.equal(kept.mrUrl, 'https://git.example/g/api/-/merge_requests/458')
  assert.deepEqual(keepOwnForge(item, undefined), item)
})

test('forge refs: GitHub issues and pull requests, on github.com and an Enterprise host', () => {
  assert.deepEqual(parseRef('https://github.com/cli/cli/issues/2'), {
    forge: 'github',
    host: 'github.com',
    path: 'cli/cli',
    kind: 'issue',
    iid: '2',
  })
  assert.deepEqual(parseRef('https://ghe.example/o/r/pull/7'), {
    forge: 'github',
    host: 'ghe.example',
    path: 'o/r',
    kind: 'change',
    iid: '7',
  })
  assert.deepEqual(titleCall(parseRef('https://github.com/cli/cli/pull/1')!), [
    'api',
    '--hostname',
    'github.com',
    'repos/cli/cli/pulls/1',
  ])
  assert.deepEqual(titleCall(parseRef('https://github.com/cli/cli/issues/2')!).at(-1), 'repos/cli/cli/issues/2')
  assert.deepEqual(titleCall(parseRef('https://git.example/a/m/-/merge_requests/3')!), [
    'api',
    '--hostname',
    'git.example',
    'projects/a%2Fm/merge_requests/3',
  ])
})

test('forge refs: work items and issues read as issues, merge requests as MRs', () => {
  assert.deepEqual(parseRef('https://git.example/a/b/api/-/work_items/617'), {
    forge: 'gitlab',
    host: 'git.example',
    path: 'a/b/api',
    kind: 'issue',
    iid: '617',
  })
  assert.deepEqual(parseRef('https://git.example/a/m/-/merge_requests/3'), {
    forge: 'gitlab',
    host: 'git.example',
    path: 'a/m',
    kind: 'change',
    iid: '3',
  })
  assert.equal(parseRef('https://git.example/a/m'), undefined)
})

test('progress: one visual per step, at the running step, or where it failed', () => {
  const p = progressOf({
    id: 'x',
    status: 'running',
    steps: [
      { id: 'a', status: 'done' },
      { id: 'b', status: 'skipped' },
      { id: 'c', name: 'Gate C', status: 'running' },
      { id: 'd', status: 'pending' },
    ],
  })
  assert.deepEqual(p, { steps: ['done', 'done', 'active', 'pending'], at: 3, name: 'Gate C' })
  const f = progressOf({
    id: 'y',
    status: 'failed',
    steps: [
      { id: 'a', status: 'done' },
      { id: 'b', status: 'failed' },
      { id: 'c', status: 'pending' },
    ],
  })
  assert.deepEqual(f, { steps: ['done', 'failed', 'pending'], at: 2, name: 'b' })
  assert.equal(progressOf({ id: 'z', status: 'queued' }), null)
})

test('finished: done and cancelled runs of the window, newest first, with their duration', () => {
  const t = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
  const s = summarize(
    [
      { id: 'd1', status: 'done', startedAt: t(3), finishedAt: t(2) },
      { id: 'c1', status: 'cancelled', startedAt: t(1.5), finishedAt: t(1) },
      { id: 'old', status: 'done', startedAt: t(50), finishedAt: t(49) },
      { id: 'arch', status: 'done', finishedAt: t(1), archived: true },
    ],
    o,
  )
  assert.deepEqual(
    s.finished?.map((r) => `${r.id}:${r.status}`),
    ['c1:cancelled', 'd1:done'],
  )
  assert.equal(s.finishedInWindow, 2)
  assert.equal(s.finished?.[1].durationMs, 3_600_000)
  assert.equal(duration(42 * 60_000), '42 min')
  assert.equal(duration(72 * 60_000), '1 h 12 min')
  assert.equal(duration(120 * 60_000), '2 h')
  const cockpit = { url: 'c', host: 'c', available: [], watched: [], credentialSource: null, streaming: true }
  const snap: Snapshot = { at: NOW, cockpits: [{ ...cockpit, projects: [s] }] }
  assert.deepEqual(
    newlyDone(snap, new Set()).map((r) => r.id),
    ['d1'],
  )
  assert.deepEqual(newlyDone(snap, new Set(['d1:done'])), [])
})

test('MR URL: opened, from a ref, or the one candidate with the run MR number', () => {
  const u = (repo: string, n: number) => `https://git.example/g/${repo}/-/merge_requests/${n}`
  assert.equal(mrUrlOf({ id: 'a', status: 'done', pullRequestUrl: u('x', 1) }), u('x', 1))
  assert.equal(mrUrlOf({ id: 'b', status: 'done', prNumber: 2, prRefs: [{ number: 2, url: u('y', 2) }] }), u('y', 2))
  assert.equal(
    mrUrlOf({
      id: 'c',
      status: 'done',
      prNumber: 19,
      prRefs: [{ number: 19 }],
      referencedPrCandidates: [u('a', 5), u('b', 19), u('c', 190)],
    }),
    u('b', 19),
  )
  assert.equal(mrUrlOf({ id: 'd', status: 'done', prNumber: 7, referencedPrCandidates: [u('a', 7), u('b', 7)] }), null)
  assert.equal(mrUrlOf({ id: 'e', status: 'done', prNumber: 75, referencedPrCandidates: [u('a', 3)] }), null)
})

test('MRs: the feature the run worked on first, then the report it opened along the way', () => {
  const u = (n: number) => `https://git.example/g/engine/-/merge_requests/${n}`
  // Cezar's pullRequestUrl is the last MR opened - here a security report on the feature MR !3.
  const run = {
    id: 'sec',
    status: 'failed',
    pullRequestUrl: u(4),
    prNumber: 4,
    prRefs: [{ number: 3 }, { number: 4, url: u(4) }],
    referencedPrCandidates: [u(1), 'https://git.example/g/other/-/merge_requests/453', u(3), u(4)],
  }
  assert.deepEqual(mrsOf(run), [
    { number: 3, url: u(3) },
    { number: 4, url: u(4) },
  ])
  assert.equal(mrUrlOf(run), u(3))
  const s = summarize([{ ...run, finishedAt: new Date(NOW).toISOString(), error: 'x' }], o)
  assert.equal(s.problems[0].mrUrl, u(3))
  assert.equal(s.problems[0].prNumber, 3)
  assert.deepEqual(s.problems[0].moreMrs, [{ number: 4, url: u(4) }])
  assert.deepEqual(mrsOf({ id: 'none', status: 'done' }), [])
})

test('forge answers: an MR names its source branch (GitLab source_branch, GitHub head.ref)', () => {
  assert.deepEqual(forgeInfo({ title: ' Draft: feat: D1 ', source_branch: 'feat/d1-phase-1' }), {
    title: 'Draft: feat: D1',
    branch: 'feat/d1-phase-1',
  })
  assert.deepEqual(forgeInfo({ title: 'Add x', head: { ref: 'add-x' } }), { title: 'Add x', branch: 'add-x' })
  assert.deepEqual(forgeInfo({ title: 'An issue' }), { title: 'An issue', branch: null })
  assert.deepEqual(forgeInfo(null), { title: null, branch: null })
})

test('repoKey: HTTPS and SSH addresses of one repository match', () => {
  const k = 'git.example.com/group/sub/app'
  assert.equal(repoKey('https://git.example.com/group/sub/app'), k)
  assert.equal(repoKey('https://git.example.com/group/sub/app.git/'), k)
  assert.equal(repoKey('git@git.example.com:group/sub/app.git'), k)
  assert.equal(repoKey('ssh://git@git.example.com:2222/group/sub/app.git'), k)
  assert.equal(repoKey(''), null)
  assert.equal(repoKey('not a url'), null)
})

test('pickWorkspace: the main checkout of the run repository, on this machine', () => {
  const ws = (id: string, x: Partial<WorkspaceInfo>): WorkspaceInfo => ({
    id,
    kind: 'worktree',
    name: id,
    path: `/w/${id}`,
    branch: 'feat/x',
    hostId: null,
    repo: 'git.example.com/group/app',
    ...x,
  })
  const list = [
    ws('other', { repo: 'git.example.com/group/other', kind: 'folder' }),
    ws('feature', {}),
    ws('remote-main', { branch: 'main', hostId: 'ssh-box' }),
    ws('main', { branch: 'main' }),
  ]
  assert.equal(pickWorkspace(list, 'git@git.example.com:group/app.git')?.id, 'main')
  assert.equal(pickWorkspace(list.slice(0, 2), 'https://git.example.com/group/app')?.id, 'feature')
  assert.equal(pickWorkspace(list, 'https://git.example.com/group/none'), null)
  assert.equal(pickWorkspace(list, undefined), null)
})

test('explainPrompt fills the run in; an empty template takes the built-in one', () => {
  const v = { url: 'https://c/p/app/tasks/r1', title: 'Fix login', project: 'app', cockpit: 'https://c', run: 'r1' }
  assert.equal(explainPrompt('/cezar-skill explain {url} ({project}, {run})', v), '/cezar-skill explain https://c/p/app/tasks/r1 (app, r1)')
  assert.match(explainPrompt('  ', v), /https:\/\/c\/p\/app\/tasks\/r1.*project app/)
  assert.ok(!explainPrompt('', v).includes('Fix login'), 'the built-in prompt never carries the issue-written title')
  assert.deepEqual(parseRunLink(v.url), { cockpit: 'https://c', project: 'app', id: 'r1' })
})

test('explain goes through a cockpit skill found in the workspace, unless the person wrote a prompt', () => {
  const meta = skillMeta('---\nname: team-cezar-cockpit\ndisable-model-invocation: true\ndescription: Operate a Cezar agent cockpit from the terminal\n---\n# body')
  assert.deepEqual(meta, { name: 'team-cezar-cockpit', description: 'Operate a Cezar agent cockpit from the terminal' })
  assert.equal(skillMeta('# no front matter'), null)
  const skills = [{ name: 'cezar-workflow', description: 'Write workflows' }, meta!]
  assert.equal(cockpitSkill(skills), 'team-cezar-cockpit')
  assert.equal(cockpitSkill([{ name: 'cezar-kokpit', description: '' }]), 'cezar-kokpit')
  assert.equal(cockpitSkill([{ name: 'cezar-tools:cockpit', description: 'Operate a cockpit' }]), 'cezar-tools:cockpit')
  assert.equal(cockpitSkill([{ name: 'cezar:tools', description: 'no match' }]), null)
  assert.equal(cockpitSkill([{ name: 'other', description: 'a cockpit' }]), null)
  const v = { url: 'https://c/p/app/tasks/r1', title: 'Fix', project: 'app', cockpit: 'https://c', run: 'r1' }
  assert.match(explainRequest('', 'team-cezar-cockpit', v), /^\/team-cezar-cockpit Explain what is happening with Cezar run https:\/\/c\/p\/app\/tasks\/r1/)
  assert.equal(explainRequest('look at {run}', 'team-cezar-cockpit', v), 'look at r1')
  assert.ok(!explainRequest('', null, v).startsWith('/'))
})
