// Titles of the issues and merge/pull requests runs point at, read with the forge's own CLI the
// person is already logged in with - `glab` for GitLab, `gh` for GitHub; both optional (the cockpit
// itself only knows their state). One call per link, cached by the worker; a failure is remembered
// for a while so a missing login is not retried on every event.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

export type Forge = 'gitlab' | 'github'

export type ForgeRef = {
  forge: Forge
  host: string
  /** `group/sub/repo` on GitLab, `owner/repo` on GitHub. */
  path: string
  kind: 'issue' | 'change'
  iid: string
}

/** GitLab: `https://host/<group>/<repo>/-/(work_items|issues|merge_requests)/N` (the `/-/` marks it).
 *  GitHub, github.com or Enterprise: `https://host/<owner>/<repo>/(issues|pull)/N`. */
export function parseRef(url: string | null | undefined): ForgeRef | undefined {
  const u = String(url ?? '')
  const gl = u.match(/^https?:\/\/([^/]+)\/(.+?)\/-\/(work_items|issues|merge_requests)\/(\d+)/)
  if (gl) {
    return {
      forge: 'gitlab',
      host: gl[1],
      path: gl[2],
      kind: gl[3] === 'merge_requests' ? 'change' : 'issue',
      iid: gl[4],
    }
  }
  const gh = u.match(/^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)/)
  if (gh) {
    return { forge: 'github', host: gh[1], path: gh[2], kind: gh[3] === 'pull' ? 'change' : 'issue', iid: gh[4] }
  }
  return undefined
}

const find = (name: string) =>
  [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`].find((p) => existsSync(p)) ?? name

const CLI: Record<Forge, string> = { gitlab: find('glab'), github: find('gh') }

const available: Partial<Record<Forge, Promise<boolean>>> = {}

/** Is the forge's CLI (`glab`, `gh`) installed? Without it the panel shows Cezar's own titles and
 *  no links to that forge's issues and merge requests. Checked once per worker. */
export function cliAvailable(forge: Forge): Promise<boolean> {
  available[forge] ??= new Promise((resolve) => {
    execFile(CLI[forge], ['--version'], { timeout: 10_000 }, (err) => resolve(!err))
  })
  return available[forge]
}

/** The REST call that answers the title: GitLab issues and MRs; GitHub's issues endpoint, which
 *  answers for pull requests too. */
export function titleCall(ref: ForgeRef): string[] {
  if (ref.forge === 'gitlab') {
    const kind = ref.kind === 'change' ? 'merge_requests' : 'issues'
    return ['api', '--hostname', ref.host, `projects/${encodeURIComponent(ref.path)}/${kind}/${ref.iid}`]
  }
  return ['api', '--hostname', ref.host, `repos/${ref.path}/issues/${ref.iid}`]
}

export function fetchTitle(ref: ForgeRef): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(CLI[ref.forge], titleCall(ref), { timeout: 15_000, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      try {
        const title = (JSON.parse(stdout) as { title?: unknown }).title
        resolve(typeof title === 'string' && title.trim() ? title.trim() : null)
      } catch {
        resolve(null)
      }
    })
  })
}
