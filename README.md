# Cezar - Orca plugin

Follows the projects of one or more Cezar cockpits live: what is running now and whether anything
failed. It reads the cockpit's HTTP API (`/api/v1`, the same calls the cockpit's own page makes) and
never changes anything there.

- **Live, no polling.** A project's full run list is fetched once, then every `fullRefreshMinutes`
  (30 by default) and after a dropped connection. Changes arrive on the cockpit's event stream
  (`GET /p/<project>/events`): new runs, steps, endings, deletions.
- **Status bar:** `Cezar 🔴 1 🟢 2` - unseen problems and running runs; a click reloads.
- **Panel** (right sidebar, robot icon), laid out like Orca's activity list: cockpit → project →
  tasks. A project is a collapsible group whose dot turns red with a problem (a failed run with its
  gate's failure line, a run asking a question, an account usage limit, a gate being retried, a
  worktree that needs attention, a read error) and green while something runs; ✓ marks its problems
  as seen. Each task shows the cockpit's step dots (done, running, failed, pending) with its place in
  the workflow, e.g. `5/14 · <step>`; a click opens the run in the cockpit.
- **Finished runs:** each project ends with a collapsible "Zakończone" list - the last runs that
  ended, with their duration.
- **Merge requests by branch:** a task links every MR it touched, named by its source branch
  (`feat/checkout-title`, not `!3`). The MR it worked on comes first; one it opened along the way
  (a security report, a changelog) follows. A run that continued an MR often records its number
  only: the URL is found among the issue's related MRs.
- **Explain:** the "Wyjaśnij" button under a task starts an agent session (Claude by default) asked
  to explain the run - in the workspace of the run's repository (its `origin` matches the project's
  repository), else in the workspace you have open. When you have a Cezar cockpit skill installed (a
  skill with "cezar" in its name and "cockpit" in its name or description, in `~/.claude/skills`,
  `~/.agents/skills` or a Claude Code plugin), the prompt goes through it. It starts with
  `orca agent launch --focus`, so the session opens as a chat or a terminal per your Orca settings
  and is shown at once.
- **Desktop notifications** on a new failed run, a question and a usage-limit hold; optionally when
  a run finishes.

## Install

Needs Orca 1.4.252 or newer (`orca plugin install` is missing in older builds - update Orca first).

```sh
orca plugin install mercs600/orca-cezar-monitor@v0.5.0   # a release; leave out @v0.5.0 for the latest main
```

Orca lists the access the plugin asks for - its own Node.js worker, its own storage, settings and
encrypted secrets, desktop notifications, reading your workspaces and starting agents in them (for
"Wyjaśnij") - and runs nothing until you approve it and turn it on in
Settings → Plugins. It installs as `mercs600.cezar-monitor`; `orca plugin update` brings newer
releases.

From a clone instead (development):

```sh
git clone https://github.com/mercs600/orca-cezar-monitor
orca plugin dev load ./orca-cezar-monitor                         # prints the access and a fingerprint
orca plugin dev load ./orca-cezar-monitor --approve <fingerprint>
```

Then open the **Cezar** panel (robot icon in the right sidebar) and add your cockpit.

## Setup

In the panel, the ⚙ in its header: add a cockpit, pick the projects to follow, save a login. Or Orca
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

**Explain** (Settings → Cezar): "Explain with agent" picks the agent (`claude`, `codex`, ...);
"Explain prompt" replaces the built-in prompt, with `{url}`, `{project}`, `{cockpit}`, `{run}` and
`{title}` filled in. Start it with `/<skill>` to use a skill of your choice. The built-in prompt holds
the run's link only: `{title}` comes from the issue, which anyone who files issues writes, so add it
only if you trust them.

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
