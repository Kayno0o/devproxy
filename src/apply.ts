import type { Resolved, Route } from './config'
import type { Skipped } from './labels'
import type { Group, Watcher } from './render'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { checkRoutes, GROUP_NAME } from './config'
import entrypoint from './entrypoint.sh' with { type: 'text' }
import { LABEL_GROUP } from './labels'
import { certHosts, MAIN, paths, renderCompose, renderGroupSni, renderHttp, renderNginx, renderSni } from './render'

export const isLabelGroup = (name: string) => name.startsWith(LABEL_GROUP)

// The groups other tools registered, one JSON file each under groups/.
export function readGroups(config: Resolved): Group[] {
  const dir = join(config.dir, 'groups')

  if (!existsSync(dir))
    return []

  return readdirSync(dir).filter(file => file.endsWith('.json')).sort().map(file => ({
    name: file.slice(0, -'.json'.length),
    routes: (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { routes: Route[] }).routes,
  }))
}

// Groups named docker-* belong to the watch service, which rewrites them from the containers' labels.
export function checkGroupName(name: string) {
  if (!GROUP_NAME.test(name) || name === MAIN || isLabelGroup(name))
    throw new Error(`${name} is not a group name: letters, digits, dot, dash and underscore, neither "${MAIN}" nor starting with "${LABEL_GROUP}"`)
}

const groupFile = (config: Resolved, name: string) => join(config.dir, 'groups', `${name}.json`)

const groupText = (group: Group) => `${JSON.stringify({ routes: group.routes }, null, 2)}\n`

// Renamed into place, so an apply running beside it never reads half a file.
function writeGroup(config: Resolved, group: Group) {
  const file = groupFile(config, group.name)

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, groupText(group))
  renameSync(`${file}.tmp`, file)
}

export function checkAll(config: Resolved, groups: Group[]) {
  checkRoutes([
    ...config.routes.map(route => ({ route, where: 'the config' })),
    ...groups.flatMap(group => group.routes.map(route => ({ route, where: `group ${group.name}` }))),
  ])
}

export function saveGroup(config: Resolved, group: Group) {
  checkGroupName(group.name)
  checkAll(config, [...readGroups(config).filter(other => other.name !== group.name), group])
  writeGroup(config, group)
}

export function dropGroup(config: Resolved, name: string): boolean {
  checkGroupName(name)

  const file = groupFile(config, name)

  if (!existsSync(file))
    return false

  rmSync(file)

  return true
}

// Writes only what changed, so the proxy's watch loop reloads only on a real change.
function write(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content)
    return false

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)

  return true
}

export interface Certs {
  // Makes a certificate for the hosts at the two paths.
  make: (hosts: string[], cert: string, key: string) => void
}

// A group's certificate is made again only when its hosts change, which a .hosts file beside it records.
function ensureCert(config: Resolved, group: string, hosts: string[], certs: Certs): boolean {
  const cert = join(config.dir, paths.cert(group))
  const key = join(config.dir, paths.key(group))
  const record = `${cert.slice(0, -'.pem'.length)}.hosts`
  const wanted = `${hosts.join('\n')}\n`

  if (existsSync(cert) && existsSync(key) && existsSync(record) && readFileSync(record, 'utf8') === wanted)
    return false

  mkdirSync(dirname(cert), { recursive: true })
  certs.make(hosts, cert, key)
  writeFileSync(record, wanted)

  return true
}

export interface Applied {
  changed: string[]
  removed: string[]
}

// Regenerates every file from the config and the groups, and removes those of groups that are gone.
export function apply(config: Resolved, certs: Certs): Applied {
  const groups = readGroups(config)

  checkAll(config, groups)

  const files = new Map<string, string>([
    [paths.nginx, renderNginx(config)],
    [paths.sni, renderSni(config)],
    [paths.main, renderHttp(config, { name: MAIN, routes: config.routes })],
  ])

  for (const group of groups) {
    files.set(paths.groupHttp(group.name), renderHttp(config, group))
    files.set(paths.groupSni(group.name), renderGroupSni(group))
  }

  const changed: string[] = []

  mkdirSync(join(config.dir, paths.logs), { recursive: true })

  // The default TLS server always needs a certificate, so the main one covers localhost even with no route.
  if (ensureCert(config, MAIN, [...new Set(['localhost', ...certHosts(config.routes)])].sort(), certs))
    changed.push(paths.cert(MAIN))

  for (const group of groups) {
    const hosts = certHosts(group.routes)

    if (hosts.length && ensureCert(config, group.name, hosts, certs))
      changed.push(paths.cert(group.name))
  }

  for (const [path, content] of files) {
    if (write(join(config.dir, path), content))
      changed.push(path)
  }

  const live = new Set(groups.map(group => group.name))
  const removed: string[] = []

  // `-key.pem` is tried before `.pem`, which it also ends with.
  for (const [folder, suffixes] of [['nginx/http', ['.conf']], ['nginx/sni', ['.conf']], ['certs', ['-key.pem', '.pem', '.hosts']]] as const) {
    const dir = join(config.dir, folder)

    if (!existsSync(dir))
      continue

    for (const file of readdirSync(dir)) {
      const suffix = suffixes.find(end => file.endsWith(end))
      const name = suffix === undefined ? undefined : file.slice(0, -suffix.length)

      if (name !== undefined && name !== MAIN && !live.has(name)) {
        rmSync(join(dir, file))
        removed.push(`${folder}/${file}`)
      }
    }
  }

  return { changed, removed }
}

// The config as the watch service reads it, written by every apply on the host so the service never syncs against routes that changed since.
export function writeSnapshot(config: Resolved) {
  write(join(config.dir, paths.snapshot), `${JSON.stringify(config, null, 2)}\n`)
}

// The files only the host writes, since they hold its paths, and that take effect on `devproxy up`: the compose file and the nginx entrypoint.
export function writeRuntime(config: Resolved, watcher: Watcher | undefined): string[] {
  return ([[paths.compose, renderCompose(config, watcher)], [paths.entrypoint, entrypoint]] as const).filter(([path, content]) => write(join(config.dir, path), content)).map(([path]) => path)
}

export function readSnapshot(dir: string): Resolved {
  const file = join(dir, paths.snapshot)

  if (!existsSync(file))
    throw new Error(`no ${file}: \`devproxy up\` writes it`)

  return JSON.parse(readFileSync(file, 'utf8')) as Resolved
}

export interface LabelReport {
  at: string
  groups: string[]
  skipped: Skipped[]
}

// Replaces the docker-* groups with these; true when one changed.
export function syncLabelGroups(config: Resolved, groups: Group[]): boolean {
  const wanted = new Map(groups.map(group => [group.name, groupText(group)]))
  let changed = false

  for (const group of readGroups(config).filter(group => isLabelGroup(group.name) && !wanted.has(group.name))) {
    rmSync(groupFile(config, group.name))
    changed = true
  }

  for (const group of groups) {
    const file = groupFile(config, group.name)

    if (existsSync(file) && readFileSync(file, 'utf8') === wanted.get(group.name))
      continue

    writeGroup(config, group)
    changed = true
  }

  return changed
}

// What the last sync kept and left out, for `devproxy status`.
export function writeLabelReport(config: Resolved, groups: Group[], skipped: Skipped[]) {
  write(join(config.dir, paths.labels), `${JSON.stringify({ at: new Date().toISOString(), groups: groups.map(group => group.name), skipped } satisfies LabelReport, null, 2)}\n`)
}

export function readLabelReport(config: Resolved): LabelReport | undefined {
  const file = join(config.dir, paths.labels)

  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as LabelReport : undefined
}

export interface Verdict {
  state: 'ok' | 'error' | 'waiting'
  at: Date
  detail: string
}

export function readVerdict(config: Resolved): Verdict | undefined {
  const file = join(config.dir, paths.status)

  if (!existsSync(file))
    return undefined

  const [head = '', ...rest] = readFileSync(file, 'utf8').split('\n')
  const [state, at] = head.split(' ')

  return { state: state as Verdict['state'], at: new Date(at ?? statSync(file).mtime), detail: rest.join('\n').trim() }
}

// Waits for the proxy to test the config written after `since`; undefined when it gave no verdict in time, which means it is not running.
export async function waitVerdict(config: Resolved, since: Date, timeoutMs = 15_000, pollMs = 250): Promise<Verdict | undefined> {
  const end = Date.now() + timeoutMs
  const status = join(config.dir, paths.status)

  while (Date.now() < end) {
    if (existsSync(status) && statSync(status).mtimeMs >= since.getTime()) {
      const verdict = readVerdict(config)

      if (verdict !== undefined && verdict.state !== 'waiting')
        return verdict
    }

    await Bun.sleep(pollMs)
  }

  return undefined
}

// Asks the proxy to test and reload even when no file changed, such as after `docker compose up` of a stack it failed to resolve.
export function touchReload(config: Resolved) {
  const file = join(config.dir, paths.reload)

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${new Date().toISOString()}\n`)
}
