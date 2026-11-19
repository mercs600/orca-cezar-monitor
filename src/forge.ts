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

/** The REST call that answers the title (and an MR's source branch): GitLab issues and MRs,
 *  GitHub issues and pull requests. */
export function titleCall(ref: ForgeRef): string[] {
  if (ref.forge === 'gitlab') {
    const kind = ref.kind === 'change' ? 'merge_requests' : 'issues'
    return ['api', '--hostname', ref.host, `projects/${encodeURIComponent(ref.path)}/${kind}/${ref.iid}`]
  }
  return ['api', '--hostname', ref.host, `repos/${ref.path}/${ref.kind === 'change' ? 'pulls' : 'issues'}/${ref.iid}`]
}

/** What the forge says of an issue or MR: its title, and for an MR its source branch. */
export type ForgeInfo = { title: string | null; branch: string | null }

/** Reads the forge's answer: GitLab `title` + `source_branch`, GitHub `title` + `head.ref`. */
export function forgeInfo(json: unknown): ForgeInfo {
  const o = (json ?? {}) as { title?: unknown; source_branch?: unknown; head?: { ref?: unknown } }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return { title: str(o.title), branch: str(o.source_branch) ?? str(o.head?.ref) }
}

export function fetchTitle(ref: ForgeRef): Promise<ForgeInfo | null> {
  return new Promise((resolve) => {
    execFile(CLI[ref.forge], titleCall(ref), { timeout: 15_000, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      try {
        resolve(forgeInfo(JSON.parse(stdout)))
      } catch {
        resolve(null)
      }
    })
  })
}

/** The merge requests GitLab relates to an issue (it lists the ones that mention or close it), so a
 *  run that recorded only an MR number can be matched to the MR's URL. GitHub: not looked up. */
export function fetchRelatedMrs(ref: ForgeRef): Promise<{ iid: number; url: string }[] | null> {
  if (ref.forge !== 'gitlab' || ref.kind !== 'issue') {
    return Promise.resolve(null)
  }
  const api = `projects/${encodeURIComponent(ref.path)}/issues/${ref.iid}/related_merge_requests`
  return new Promise((resolve) => {
    execFile(CLI.gitlab, ['api', '--hostname', ref.host, api], { timeout: 15_000, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      try {
        const list = JSON.parse(stdout) as { iid?: unknown; web_url?: unknown }[]
        resolve(
          list
            .filter((m) => typeof m.iid === 'number' && typeof m.web_url === 'string')
            .map((m) => ({ iid: m.iid as number, url: m.web_url as string }))
        )
      } catch {
        resolve(null)
      }
    })
  })
}
