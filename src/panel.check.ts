// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh host.
// The cockpit addresses are unreachable on purpose: the worker fails fast and the panel shows
// the seeded snapshot.
import { defineCheck } from 'orca/testing'

const now = Date.now()
const url = 'https://cezar.invalid:4443'
const link = (id: string) => `${url}/p/web-app/tasks/${id}`
const settings = { cockpits: `${url} web-app, api, worker` }

export default defineCheck({
  fresh: { settings },
  tree: {
    settings,
    storage: {
      snapshot: {
        at: now - 20_000,
        cockpits: [
          {
            url,
            host: 'cezar.invalid',
            available: ['web-app', 'api', 'worker'],
            watched: ['web-app', 'api', 'worker'],
            credentialSource: 'macOS keychain',
            streaming: true,
            projects: [
              {
                project: 'web-app',
                ok: true,
                doneInWindow: 4,
                live: [],
                problems: [
                  {
                    key: 'r2:failed',
                    runId: 'r2',
                    kind: 'failed',
                    title: '#250 checkout page title',
                    detail: 'ui-check: ✘ title differs',
                    at: now - 3_600_000,
                    issueNumber: 250,
                    prNumber: null,
                    url: link('r2')
                  }
                ]
              },
              {
                project: 'api',
                ok: true,
                doneInWindow: 9,
                live: [
                  {
                    id: 'r1',
                    title: '#616 add rate limiting',
                    workflow: 'issue-to-mr',
                    status: 'running',
                    step: 'Implementation',
                    attempt: 1,
                    startedAt: now - 42 * 60_000,
                    issueNumber: 616,
                    prNumber: null,
                    url: link('r1')
                  },
                  {
                    id: 'r3',
                    title: '#615 fix login redirect',
                    workflow: 'issue-to-mr',
                    status: 'running',
                    step: 'validate',
                    attempt: 2,
                    startedAt: now - 7 * 60_000,
                    issueNumber: 615,
                    prNumber: 17,
                    url: link('r3')
                  }
                ],
                problems: []
              },
              { project: 'worker', ok: true, doneInWindow: 0, live: [], problems: [] }
            ]
          }
        ]
      }
    }
  }
})
