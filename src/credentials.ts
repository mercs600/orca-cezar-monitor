// The cockpit login: a netrc file (~/.config/cezar/netrc, then ~/.netrc), then the macOS keychain
// item `cezar:<host>` - the places a terminal client of the cockpit reads too, so one login serves
// both. A login saved in the panel (the plugin's secrets `login:<host>` and `password:<host>`)
// comes first. The password never leaves this worker.
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Credentials = { login: string; password: string; source: string }

async function netrcEntry(file: string, host: string): Promise<Credentials | undefined> {
  let mode: number
  try {
    mode = (await stat(file)).mode
  } catch {
    return undefined
  }
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    // cezar.mjs refuses such a file; so do we, instead of reading a leaked password.
    return undefined
  }
  const tok = (await readFile(file, 'utf8')).split(/\s+/).filter(Boolean)
  let current: 'host' | 'default' | null = null
  const found: Partial<Record<'host' | 'default', { login?: string; password?: string }>> = {}
  for (let i = 0; i < tok.length; i++) {
    if (tok[i] === 'machine') {
      current = tok[++i] === host ? 'host' : null
    } else if (tok[i] === 'default') {
      current = found.host ? null : 'default'
    } else if (current && (tok[i] === 'login' || tok[i] === 'password')) {
      const entry = (found[current] ??= {})
      entry[tok[i] as 'login' | 'password'] = tok[++i]
    }
  }
  const e = found.host ?? found.default
  return e?.login ? { login: e.login, password: e.password ?? '', source: `netrc ${file}` } : undefined
}

// `security` prints a printable ASCII value in quotes and anything else as hex.
function securityValue(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined
  }
  const hex = raw.match(/^0x([0-9A-Fa-f]+)/)
  if (hex) {
    return Buffer.from(hex[1], 'hex').toString('utf8')
  }
  return raw.match(/^"(.*)"\s*$/)?.[1]
}

function keychainEntry(host: string): Promise<Credentials | undefined> {
  if (process.platform !== 'darwin') {
    return Promise.resolve(undefined)
  }
  return new Promise((resolve) => {
    // -g: attributes on stdout, the password on stderr - one item, one call.
    execFile(
      'security',
      ['find-generic-password', '-s', `cezar:${host}`, '-g'],
      { timeout: 15_000, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          resolve(undefined)
          return
        }
        const login = securityValue(stdout.match(/"acct"<blob>=(0x[0-9A-Fa-f]+|"[^\n]*")/)?.[1])
        const password = securityValue(stderr.match(/^password: (0x[0-9A-Fa-f]+|"[^\n]*")/m)?.[1])
        resolve(login && password ? { login, password, source: 'macOS keychain' } : undefined)
      }
    )
  })
}

export async function findCredentials(
  host: string,
  own: { login?: string; password?: string | null }
): Promise<Credentials | undefined> {
  if (own.login && own.password) {
    return { login: own.login, password: own.password, source: 'plugin' }
  }
  for (const file of [join(homedir(), '.config', 'cezar', 'netrc'), join(homedir(), '.netrc')]) {
    const e = await netrcEntry(file, host)
    if (e) {
      return e
    }
  }
  return keychainEntry(host)
}
