import type { Certs, Verdict } from './apply'
import type { Config, Resolved } from './config'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { captureOutput, compose, composeError, configBase, fail, loadConfig, note } from '@kaynooo/cli-kit'
import { apply, waitVerdict } from './apply'
import { resolveConfig } from './config'
import { locked } from './lock'
import { paths } from './render'

export const defaultConfigPath = () => process.env.DEVPROXY_CONFIG ?? join(configBase(), 'devproxy', 'config.ts')

export async function load(path: string | undefined): Promise<Resolved> {
  const file = path ?? defaultConfigPath()

  if (!existsSync(file))
    fail(`no config at ${file}: write one with \`devproxy init\``, 1)

  const loaded = (await loadConfig('devproxy.config', { path: file }))!

  try {
    return resolveConfig(loaded.config as Config, loaded.dir)
  }
  catch (error) {
    fail(`${loaded.path}: ${error instanceof Error ? error.message : String(error)}`, 1)
  }
}

export const mkcert: Certs = {
  make(hosts, cert, key) {
    if (Bun.which('mkcert') === null)
      fail('mkcert is not installed: it makes the certificates your browser trusts (then run `mkcert -install` once)', 1)

    const run = Bun.spawnSync(['mkcert', '-cert-file', cert, '-key-file', key, ...hosts], { stdout: 'pipe', stderr: 'pipe' })

    if (run.exitCode !== 0)
      fail(`mkcert failed: ${run.stderr.toString().trim()}`, 1)
  },
}

const composeFlags = (config: Resolved) => ['-f', join(config.dir, paths.compose)]

export async function running(config: Resolved): Promise<boolean> {
  if (Bun.which('docker') === null)
    return false

  const result = await captureOutput(['docker', 'inspect', '--format', '{{.State.Running}}', config.name])

  return result.code === 0 && result.stdout.trim() === 'true'
}

async function ensureNetwork(network: string) {
  if ((await captureOutput(['docker', 'network', 'inspect', network])).code === 0)
    return

  const created = await captureOutput(['docker', 'network', 'create', network])

  if (created.code !== 0)
    fail(`docker network create ${network}: ${composeError(created)}`, 1)
}

export async function up(config: Resolved) {
  await ensureNetwork(config.network)

  const result = await compose(['up', '-d', '--remove-orphans'], { flags: composeFlags(config) })

  if (result.code !== 0)
    fail(`docker compose up: ${composeError(result)}`, 1)
}

export async function down(config: Resolved) {
  const result = await compose(['down'], { flags: composeFlags(config) })

  if (result.code !== 0)
    fail(`docker compose down: ${composeError(result)}`, 1)
}

export interface Outcome {
  changed: string[]
  removed: string[]
  // Undefined when nothing changed or the proxy is not running, so no verdict was waited for.
  verdict: Verdict | undefined
  running: boolean
}

// Runs `change` (a group saved or dropped), regenerates the files and, when the running proxy has something new to load, waits for its verdict; all of it under the state dir's lock.
export async function applyAndWait(config: Resolved, change?: () => void): Promise<Outcome> {
  return locked(config.dir, async () => {
    change?.()

    const since = new Date()
    const { changed, removed } = apply(config, mkcert)
    const live = await running(config)

    if (!live || (!changed.length && !removed.length))
      return { changed, removed, verdict: undefined, running: live }

    const verdict = await waitVerdict(config, since)

    if (verdict === undefined)
      fail(`the proxy gave no verdict on the new config within 15 s: \`docker logs ${config.name}\` says why`, 1)

    return { changed, removed, verdict, running: live }
  }, () => note('waiting for another devproxy apply to finish'))
}
