# Cezar - Orca plugin

Follows the projects of one or more Cezar cockpits live: what is running now and whether anything
failed. It reads the cockpit's HTTP API (`/api/v1`, the same calls the cockpit's own page makes) and
never changes anything there.

- **Live, no polling.** A project's full run list is fetched once, then every `fullRefreshMinutes`
  (30 by default) and after a dropped connection. Changes arrive on the cockpit's event stream
  (`GET /p/<project>/events`): new runs, steps, endings, deletions.
- **Status bar:** `Cezar 🔴 1 🟢 2` - unseen problems and running runs; a click reloads.
- **Panel** (right sidebar, robot icon), *Projekty* tab: cockpit → project → tasks. A project
  collapses; it turns red with a problem (a failed run with its gate's failure line, a run asking a
  question, an account usage limit, a gate being retried, a worktree that needs attention, a read
  error) and green while something runs. A click on a task opens the run in the cockpit; ✓ next to
  "Problemy" marks them as seen.
- **Desktop notifications** on a new failed run, a question and a usage-limit hold.

## Setup

The panel's *Ustawienia* tab: add a cockpit, pick the projects to follow, save a login. Or Orca
Settings → Cezar → "Cockpits", one cockpit per line:

```
https://cezar.example.com:4443 web-app, api
https://cezar-2.example.com:4443
```

No projects = every project of that cockpit.

**Login** (the cockpit's Basic auth), first found wins: saved in the panel (the plugin's encrypted
secrets), `~/.config/cezar/netrc`, `~/.netrc`, the macOS keychain item `cezar:<host>`:

```sh
security add-generic-password -s 'cezar:cezar.example.com' -a '<login>' -w
```

**glab and gh (optional).** With the forge's CLI installed and logged in -
[`glab`](https://gitlab.com/gitlab-org/cli) for GitLab, [`gh`](https://cli.github.com) for GitHub
(github.com and Enterprise) - a task shows the title of its issue (or merge/pull request) with links
to both. Without it the title is the run's summary from Cezar, with no links to that forge. The forge
is told from the link itself: GitLab paths carry `/-/`.

## Development

```sh
npm install                  # Node typings and TypeScript for the type check
npx tsc -p .                 # type check (Orca typings in .orca/types)
orca plugin test .           # model and worker tests
orca plugin check .          # renders the panel in the scenarios of src/panel.check.ts
orca plugin dev load . --approve <fingerprint>   # load into Orca
orca plugin logs local.cezar-monitor
```

The panel's own texts are in Polish for now.
