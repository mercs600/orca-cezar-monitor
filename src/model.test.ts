import { parseRef, titleCall } from './forge'
import { assert, test } from 'orca/testing'
import {
  counts,
  keepOwnForge,
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
    'repos/cli/cli/issues/1',
  ])
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
