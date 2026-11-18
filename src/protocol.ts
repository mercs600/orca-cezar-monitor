// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { Snapshot } from './model'

export type MonitorState = {
  /** Per cockpit: what it has, what is watched, live and problem runs per project. */
  snapshot: Snapshot | null
  /** Problem keys the person marked as seen. */
  dismissed: string[]
  /** A full reload (GET runs of every watched project) is under way. */
  loading: boolean
  fullRefreshMinutes: number
  /** The optional forge CLIs installed (`glab`, `gh`): links to that forge's issues and merge or
   *  pull requests, with their titles. */
  clis: { gitlab: boolean; github: boolean }
}

declare module 'orca' {
  interface PluginRequests {
    'cezar.get': { output: MonitorState }
    /** Reloads every cockpit now (the full run lists) and answers the new state. */
    'cezar.refresh': { output: MonitorState }
    'cezar.dismiss': { input: { keys: string[] }; output: MonitorState }
    /** Which projects of one cockpit to watch; an empty list = every project. */
    'cezar.setProjects': { input: { cockpit: string; projects: string[] }; output: MonitorState }
    /** Adds a cockpit (all its projects) or removes one from the `cockpits` setting. */
    'cezar.addCockpit': { input: { url: string }; output: MonitorState }
    'cezar.removeCockpit': { input: { url: string }; output: MonitorState }
    /** A login for one cockpit, kept in the plugin's encrypted secrets. */
    'cezar.setLogin': { input: { cockpit: string; login: string; password: string }; output: MonitorState }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after each change. */
    'cezar.state': MonitorState
  }
}
