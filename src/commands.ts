import type { Outcome } from './runtime'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, note, ok, parse, printJson, warn } from '@kaynooo/cli-kit'
import { dropGroup, readGroups, readLabelReport, readSnapshot, readVerdict, saveGroup, waitVerdict } from './apply'
import { applyAndWait, defaultConfigPath, dockerSources, down, load, running, up, watch } from './runtime'

const configOption = { config: { type: 'string', short: 'c', description: `the config file (${'$'}DEVPROXY_CONFIG, else ~/.config/devproxy/config.ts)` } } as const

// A group refused (a bad name or route, a host routed twice) is a usage error.
function failOnError(change: () => unknown) {
  try {
    change()
  }
  catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

function report(outcome: Outcome, json: boolean) {
  if (json) {
    printJson(outcome)

    return outcome.verdict?.state === 'error' ? 1 : 0
  }

  for (const path of outcome.changed)
    note(`wrote ${path}`)

  for (const path of outcome.removed)
    note(`removed ${path}`)

  if (outcome.verdict?.state === 'error') {
    warn('nginx refused the new config and keeps serving the last one it accepted', outcome.verdict.detail)

    return 1
  }

  if (!outcome.running)
    note('the proxy is not running: `devproxy up` starts it')
  else if (outcome.verdict !== undefined)
    ok('nginx accepted the new config')
  else
    ok('nothing changed')

  return 0
}

export async function update(args: string[]): Promise<number> {
  const { values } = parse(args, 'devproxy apply\n\nGenerates nginx.conf, the SNI map, the vhosts, the compose file and the certificates again from the config and the groups, then waits for the running proxy to test and load them.\n\nExits 0 when nginx accepted them or the proxy is not running, 1 when nginx refused them.', { ...configOption, json: jsonOption('{changed, removed, verdict, running}') })

  return report(await applyAndWait(await load(values.config), { runtime: true }), values.json === true)
}

export async function upCommand(args: string[]): Promise<number> {
  const { values } = parse(args, 'devproxy up\n\nGenerates everything from the config, creates the docker network when missing and starts the proxy container, then waits for nginx to test the config.\n\nExits 1 when nginx refuses it.', configOption)
  const config = await load(values.config)

  const outcome = await applyAndWait(config, { runtime: true })
  const since = new Date()

  await up(config)

  // A proxy that was stopped tests its config as it starts; a running one already gave its verdict, or kept its last one when nothing changed.
  const verdict = outcome.running ? outcome.verdict ?? readVerdict(config) : await waitVerdict(config, since)

  if (verdict === undefined)
    fail(`the proxy gave no verdict on its config within 15 s: \`docker logs ${config.name}\` says why`, 1)

  if (verdict.state === 'error') {
    warn(outcome.running ? 'nginx refused the new config and keeps serving the last one it accepted' : 'nginx refused the config, so the proxy serves nothing until it is fixed', verdict.detail)

    return 1
  }

  ok(`${config.name} is up on ${config.ports.http} and ${config.ports.https}`)

  return 0
}

export async function downCommand(args: string[]): Promise<number> {
  const { values } = parse(args, 'devproxy down\n\nStops and removes the proxy container. The network stays, since the stacks are on it too.', configOption)

  await down(await load(values.config))

  return 0
}

export async function status(args: string[]): Promise<number> {
  const { values } = parse(args, 'devproxy status\n\nWhether the proxy runs, and what nginx said about the config it last tested.\n\nExits 0 when it runs on an accepted config, 1 otherwise.', { ...configOption, json: jsonOption('{running, verdict}') })
  const config = await load(values.config)
  const live = await running(config)
  const verdict = readVerdict(config)
  const labels = config.labels ? readLabelReport(config) : undefined

  if (values.json === true) {
    printJson({ running: live, verdict: verdict ?? null, labels: labels ?? null })

    return live && verdict?.state !== 'error' ? 0 : 1
  }

  if (!live)
    note(`${config.name} is not running`)
  else if (verdict?.state === 'error')
    warn(`${config.name} runs on its last good config: nginx refused the current one (${verdict.at.toISOString()})`, verdict.detail)
  else
    ok(`${config.name} runs`, verdict === undefined ? undefined : `${verdict.state} since ${verdict.at.toISOString()}`)

  if (labels !== undefined) {
    note(`labels: ${labels.groups.join(', ') || 'no stack'} as of ${labels.at}`)

    for (const entry of labels.skipped)
      warn(`label route skipped on ${entry.container}${entry.host === undefined ? '' : ` (${entry.host})`}`, entry.reason)
  }

  return live && verdict?.state !== 'error' ? 0 : 1
}

export async function watchCommand(args: string[]): Promise<number> {
  const { values } = parse(args, 'devproxy watch [--state <dir>]\n\nKeeps one docker-<project> group per running stack from its containers\' devproxy.* labels, following docker events. The watch service `devproxy up` starts runs it with --state, reading the config snapshot there; on the host it reads the config.', { ...configOption, state: { type: 'string', description: 'the state dir holding config.json, instead of the config' } })
  const { state } = values
  const dir = state ?? (await load(values.config)).dir
  // eslint-disable-next-line ts/require-await -- the loader is async by contract, the snapshot is read synchronously
  const config = state === undefined ? async () => load(values.config) : async () => readSnapshot(state)
  const stop = new AbortController()

  process.once('SIGTERM', () => stop.abort())
  process.once('SIGINT', () => stop.abort())
  await watch(dir, dockerSources(config), stop.signal)

  return 0
}

export async function hosts(args: string[]): Promise<number> {
  const { values } = parse(args, 'devproxy hosts\n\nEvery host the proxy serves: the config\'s routes, then each group\'s.', { ...configOption, json: jsonOption('[{host, group, to, passthrough}]') })
  const config = await load(values.config)
  const rows = [
    ...config.routes.map(route => ({ route, group: null as string | null })),
    ...readGroups(config).flatMap(entry => entry.routes.map(route => ({ route, group: entry.name }))),
  ].map(({ route, group }) => ({ host: route.host, group, to: route.to, passthrough: route.passthrough === true }))

  if (values.json === true) {
    printJson(rows)

    return 0
  }

  for (const row of rows)
    console.log(`${row.host}\t${row.group ?? '-'}\t${row.passthrough ? 'passthrough ' : ''}${row.to}`)

  return 0
}

export async function group(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, 'devproxy set <group> [--file <routes.json>]\n\nAdds or replaces a group of routes, read as {"routes": [...]} from the file or stdin, with the same fields as the config\'s routes. A group\'s hosts come before the config\'s in the SNI map, so its wildcards win.\n\nExits 0 once nginx accepted it or the proxy is not running, 1 when nginx refused it (the group stays registered), 2 on invalid routes.', { ...configOption, file: { type: 'string', short: 'f', description: 'read the routes from this file instead of stdin' }, json: jsonOption('{changed, removed, verdict, running}') }, { positionals: ['group'] })
  const [name] = positionals

  if (name === undefined)
    fail('a group name is needed')

  const text = values.file === undefined ? await Bun.stdin.text() : readFileSync(values.file, 'utf8')
  let routes: unknown

  try {
    routes = (JSON.parse(text) as { routes?: unknown }).routes
  }
  catch (error) {
    fail(`the routes are not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!Array.isArray(routes))
    fail('expected {"routes": [...]}')

  const config = await load(values.config)

  return report(await applyAndWait(config, { change: () => failOnError(() => saveGroup(config, { name, routes })) }), values.json === true)
}

export async function rm(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, 'devproxy rm <group>\n\nRemoves a group of routes and its certificate. A group that does not exist is not an error.', { ...configOption, json: jsonOption('{changed, removed, verdict, running}') }, { positionals: ['group'] })
  const [name] = positionals

  if (name === undefined)
    fail('a group name is needed')

  const config = await load(values.config)

  return report(await applyAndWait(config, { change: () => failOnError(() => dropGroup(config, name)) }), values.json === true)
}

// No import: the config sits outside any project, where the package may not resolve; `defineConfig` from @kaynooo/devproxy types one where it does.
const STARTER = `export default {
  // Where devproxy writes the nginx config, the certificates and the logs.
  dir: '~/.local/share/devproxy',
  ports: { http: 80, https: 443 },
  routes: [
    // A container on the devproxy network: add the network to the stack's compose file.
    // { host: 'app.localhost', to: 'http://app:3000' },
    // A port on this machine.
    // { host: 'docs.localhost', to: 'host:5173' },
    // A stack that terminates TLS itself, chosen by SNI.
    // { host: 'api.localhost', to: 'api-nginx:443', passthrough: true },
  ],
}
`

// eslint-disable-next-line ts/require-await -- commands are async by contract
export async function init(args: string[]): Promise<number> {
  const { values } = parse(args, 'devproxy init [--config <path>]\n\nWrites a starter config, never over an existing file.', configOption)
  const path = resolve(values.config ?? defaultConfigPath())

  if (existsSync(path))
    fail(`${path} already exists`, 1)

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, STARTER)
  ok(`wrote ${path}`, 'add your routes, then run `devproxy up`')

  return 0
}
