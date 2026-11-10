import type { Certs, Verdict } from './apply'
import type { Config, Resolved } from './config'
import type { Watcher } from './render'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { captureOutput, compose, composeError, configBase, fail, loadConfig, note } from '@kaynooo/cli-kit'
import { apply, isLabelGroup, readGroups, syncLabelGroups, waitVerdict, writeRuntime } from './apply'
import { resolveConfig } from './config'
import { dockerSocket, followEvents, runningContainers } from './docker'
import { labelGroups } from './labels'
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

function mkcertPath(): string {
  const found = Bun.which('mkcert')

  if (found === null)
    fail('mkcert is not installed: it makes the certificates your browser trusts (then run `mkcert -install` once)', 1)

  return found
}

// The package folder holding the running script, which the watch service mounts to run the same devproxy.
function packageRoot(entry: string): string {
  let dir = dirname(entry)

  while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir)
    dir = dirname(dir)

  return dir
}

// What the watch service borrows from this host; undefined when the config turns labels off.
export function watcherOf(config: Resolved): Watcher | undefined {
  if (!config.labels)
    return undefined

  const mkcertBin = realpathSync(mkcertPath())
  const caroot = Bun.spawnSync([mkcertBin, '-CAROOT'], { stdout: 'pipe' }).stdout.toString().trim()
  const socket = dockerSocket()
  const entry = realpathSync(Bun.main)

  return {
    entry,
    root: packageRoot(entry),
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    socket,
    socketGid: existsSync(socket) ? statSync(socket).gid : 0,
    mkcert: mkcertBin,
    caroot,
  }
}

export const mkcert: Certs = {
  make(hosts, cert, key) {
    const run = Bun.spawnSync([mkcertPath(), '-cert-file', cert, '-key-file', key, ...hosts], { stdout: 'pipe', stderr: 'pipe' })

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
    const runtime = writeRuntime(config, watcherOf(config))
    const { changed, removed } = apply(config, mkcert)

    changed.unshift(...runtime)
    const live = await running(config)

    if (!live || (!changed.length && !removed.length))
      return { changed, removed, verdict: undefined, running: live }

    const verdict = await waitVerdict(config, since)

    if (verdict === undefined)
      fail(`the proxy gave no verdict on the new config within 15 s: \`docker logs ${config.name}\` says why`, 1)

    return { changed, removed, verdict, running: live }
  }, () => note('waiting for another devproxy apply to finish'))
}

const DEBOUNCE_MS = 500
const RETRY_MS = 2000

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`)

// One pass of the watch service: the labels of the running containers become the docker-* groups, then nginx's files are made again and its verdict logged.
export async function syncLabels(config: Resolved): Promise<void> {
  await locked(config.dir, async () => {
    const others = readGroups(config).filter(group => !isLabelGroup(group.name))
    const { groups, skipped } = labelGroups(config, others, await runningContainers())

    for (const entry of skipped)
      log(`skipped ${entry.host ?? ''} on ${entry.container}: ${entry.reason}`)

    if (!syncLabelGroups(config, groups, skipped))
      return

    const since = new Date()
    const { changed, removed } = apply(config, mkcert)

    log(`groups ${groups.map(group => group.name).join(' ') || 'none'}: ${changed.length} written, ${removed.length} removed`)

    if (!changed.length && !removed.length)
      return

    const verdict = await waitVerdict(config, since)

    log(verdict === undefined ? 'no verdict from nginx yet, is the proxy running?' : `nginx: ${verdict.state}${verdict.detail ? `\n${verdict.detail}` : ''}`)
  })
}

// Syncs once, then again a moment after every burst of container events; a lost event stream is followed again after a full sync, so nothing missed meanwhile stays stale.
export async function watch(config: Resolved, signal?: AbortSignal): Promise<void> {
  let timer: Timer | undefined
  let draining: Promise<void> | undefined
  let again = false

  // Events landing during a sync ask for one more pass, never for a second sync beside it.
  const drain = async () => {
    do {
      again = false

      try {
        await syncLabels(config)
      }
      catch (error) {
        log(`sync failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } while (again)

    draining = undefined
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      again = true
      draining ??= drain()
    }, DEBOUNCE_MS)
  }

  const stopped = () => signal?.aborted === true

  log(`watching the labels of containers on ${config.network}`)

  while (!stopped()) {
    schedule()

    try {
      await followEvents(schedule, signal)
      log('the docker event stream ended, following it again')
    }
    catch (error) {
      if (stopped())
        break

      log(`docker events: ${error instanceof Error ? error.message : String(error)}`)
    }

    await Bun.sleep(RETRY_MS)
  }

  clearTimeout(timer)
  await draining
}
