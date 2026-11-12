import type { Certs, Verdict } from './apply'
import type { Config, Resolved } from './config'
import type { Container } from './labels'
import type { Watcher } from './render'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { captureOutput, compose, composeError, configBase, fail, loadConfig, note } from '@kaynooo/cli-kit'
import { apply, isLabelGroup, readGroups, syncLabelGroups, waitVerdict, writeLabelReport, writeRuntime, writeSnapshot } from './apply'
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

interface ApplyOptions {
  // A group saved or dropped, run under the lock.
  change?: () => void
  // Writes the compose file and the entrypoint too, which only `up` and `apply` need, and which take mkcert's paths for the watch service.
  runtime?: boolean
}

// Runs the change, regenerates the files and, when the running proxy has something new to load, waits for its verdict; all of it under the state dir's lock.
export async function applyAndWait(config: Resolved, { change, runtime = false }: ApplyOptions = {}): Promise<Outcome> {
  return locked(config.dir, async () => {
    change?.()

    // With labels off, the groups the watch service left behind would be served for good.
    if (!config.labels)
      syncLabelGroups(config, [])

    const since = new Date()
    const written = runtime ? writeRuntime(config, watcherOf(config)) : []

    writeSnapshot(config)

    const { changed, removed } = apply(config, mkcert)
    // nginx only reads its own files and the certs; a new compose file reaches the proxy when `up` recreates it.
    const fresh = changed.length > 0 || removed.length > 0

    changed.unshift(...written)
    const live = await running(config)

    if (!live || !fresh)
      return { changed, removed, verdict: undefined, running: live }

    const verdict = await waitVerdict(config, since)

    if (verdict === undefined)
      fail(`the proxy gave no verdict on the new config within 15 s: \`docker logs ${config.name}\` says why`, 1)

    return { changed, removed, verdict, running: live }
  }, { waiting: () => note('waiting for another devproxy apply to finish') })
}

const DEBOUNCE_MS = 500
const RETRY_MS = 2000

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`)

export interface LabelSources {
  // Read again on every pass, so a route the host applied since is never undone.
  config: () => Promise<Resolved>
  containers: () => Promise<Container[]>
  // Calls `changed` on every event until the stream ends.
  events: (changed: () => void, signal?: AbortSignal) => Promise<void>
  certs: Certs
  verdictMs?: number
  retryMs?: number
}

export const dockerSources = (config: () => Promise<Resolved>): LabelSources => ({ config, containers: runningContainers, events: followEvents, certs: mkcert })

// One pass of the watch service: the labels of the running containers become the docker-* groups, then nginx's files are made again and its verdict logged. Apply runs even when no group changed, so a pass that failed halfway is finished by the next.
export async function syncLabels(dir: string, sources: LabelSources): Promise<void> {
  await locked(dir, async () => {
    const config = await sources.config()

    // A watcher still running after labels were turned off leaves the groups to the next apply, which drops them.
    if (!config.labels)
      return

    const others = readGroups(config).filter(group => !isLabelGroup(group.name))
    const { groups, skipped } = labelGroups(config, others, await sources.containers())

    for (const entry of skipped)
      log(`skipped ${entry.host ?? ''} on ${entry.container}: ${entry.reason}`)

    syncLabelGroups(config, groups)
    writeLabelReport(config, groups, skipped)

    const since = new Date()
    const { changed, removed } = apply(config, sources.certs)

    if (!changed.length && !removed.length)
      return

    log(`groups ${groups.map(group => group.name).join(' ') || 'none'}: ${changed.length} written, ${removed.length} removed`)

    const verdict = await waitVerdict(config, since, sources.verdictMs)

    log(verdict === undefined ? 'no verdict from nginx yet, is the proxy running?' : `nginx: ${verdict.state}${verdict.detail ? `\n${verdict.detail}` : ''}`)
  })
}

// Syncs once, then again a moment after every burst of container events; a lost event stream is followed again after a full sync, so nothing missed meanwhile stays stale.
export async function watch(dir: string, sources: LabelSources, signal?: AbortSignal): Promise<void> {
  let timer: Timer | undefined
  let draining: Promise<void> | undefined
  let again = false
  const stopped = () => signal?.aborted === true
  const retryMs = sources.retryMs ?? RETRY_MS

  // Events landing during a sync ask for one more pass, never for a second sync beside it; a failed pass is tried again, since no event may come to retry it.
  const drain = async () => {
    do {
      again = false

      try {
        await syncLabels(dir, sources)
      }
      catch (error) {
        log(`sync failed, trying again in ${retryMs / 1000} s: ${error instanceof Error ? error.message : String(error)}`)
        await Bun.sleep(retryMs)
        again = true
      }
    } while (again && !stopped())

    draining = undefined
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      again = true
      draining ??= drain()
    }, DEBOUNCE_MS)
  }

  log(`watching the labels of the containers devproxy reaches, state in ${dir}`)

  while (!stopped()) {
    schedule()

    try {
      await sources.events(schedule, signal)
      log('the docker event stream ended, following it again')
    }
    catch (error) {
      if (stopped())
        break

      log(`docker events: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!stopped())
      await Bun.sleep(retryMs)
  }

  clearTimeout(timer)
  await draining
}
