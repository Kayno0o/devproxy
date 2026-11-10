import type { Resolved, Route } from './config'
import type { Group } from './render'
import { checkRoutes } from './config'

// What devproxy needs to know of a running container.
export interface Container {
  name: string
  // The compose project, which names the group its routes go in.
  project: string | undefined
  labels: Record<string, string>
  networks: string[]
}

export interface Skipped {
  container: string
  host: string | undefined
  reason: string
}

export const LABEL_PREFIX = 'devproxy.'
export const LABEL_GROUP = 'docker-'

const FIELDS = new Set(['host', 'port', 'scheme', 'to', 'passthrough', 'buffering', 'keepalive'])
const ROUTE_NAME = /^[\w-]+$/
const PORT = /^\d{1,5}$/
const DIGITS = /^\d+$/
const BOOLEAN = new Set(['true', 'false'])

export const groupOf = (container: Container): string => `${LABEL_GROUP}${container.project ?? container.name}`

// The labels of one route, `devproxy.<route>.<field>`, by route name; a label outside that shape is reported, not ignored.
function byRoute(container: Container, skipped: Skipped[]): Map<string, Map<string, string>> {
  const routes = new Map<string, Map<string, string>>()

  for (const [key, value] of Object.entries(container.labels)) {
    if (!key.startsWith(LABEL_PREFIX))
      continue

    const [name = '', field = '', ...rest] = key.slice(LABEL_PREFIX.length).split('.')

    if (!ROUTE_NAME.test(name) || !FIELDS.has(field) || rest.length) {
      skipped.push({ container: container.name, host: undefined, reason: `label ${key} is not devproxy.<route>.<${[...FIELDS].join('|')}>` })

      continue
    }

    routes.set(name, (routes.get(name) ?? new Map<string, string>()).set(field, value.trim()))
  }

  return routes
}

// One route's labels as routes, one per host; throws with what is wrong.
function parse(container: Container, network: string, fields: Map<string, string>): Route[] {
  const get = (field: string) => fields.get(field)
  const flag = (field: string) => {
    const value = get(field)

    if (value !== undefined && !BOOLEAN.has(value))
      throw new Error(`${field} is ${value}, not true or false`)

    return value === undefined ? undefined : value === 'true'
  }
  const hosts = (get('host') ?? '').split(',').map(host => host.trim()).filter(Boolean)
  const passthrough = flag('passthrough') === true
  const buffering = flag('buffering')
  const port = get('port')
  const scheme = get('scheme')
  const keepalive = get('keepalive')

  if (!hosts.length)
    throw new Error('no host label')

  if (port !== undefined && !PORT.test(port))
    throw new Error(`port ${port} is not a port number`)

  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https')
    throw new Error(`scheme ${scheme} is not http or https`)

  if (keepalive !== undefined && !DIGITS.test(keepalive))
    throw new Error(`keepalive ${keepalive} is not a number`)

  if (get('to') !== undefined && (port !== undefined || scheme !== undefined))
    throw new Error('to names the whole upstream, so it takes no port or scheme')

  if (get('to') === undefined && !container.networks.includes(network))
    throw new Error(`the container is not on the ${network} network, so the proxy cannot reach it`)

  if (passthrough && scheme !== undefined)
    throw new Error('a passthrough route forwards TLS as is, so it takes no scheme')

  const to = get('to') ?? (passthrough ? `${container.name}:${port ?? 443}` : `${scheme ?? 'http'}://${container.name}:${port ?? 80}`)

  return hosts.map(host => ({
    host,
    to,
    ...passthrough ? { passthrough } : {},
    ...buffering === undefined ? {} : { buffering },
    ...keepalive === undefined ? {} : { keepaliveRequests: Number(keepalive) },
  }))
}

/**
 * The groups the running containers' labels ask for, one per compose project, and every route left out with why.
 * A route is kept only when nginx can serve it beside the config's routes, the groups registered with `devproxy set` and the label routes kept before it, so one bad label never takes the others down.
 */
export function labelGroups(config: Resolved, others: Group[], containers: Container[]): { groups: Group[], skipped: Skipped[] } {
  const skipped: Skipped[] = []
  const kept: { route: Route, where: string }[] = [
    ...config.routes.map(route => ({ route, where: 'the config' })),
    ...others.flatMap(group => group.routes.map(route => ({ route, where: `group ${group.name}` }))),
  ]
  const groups = new Map<string, Route[]>()

  for (const container of [...containers].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const [name, fields] of byRoute(container, skipped)) {
      let routes: Route[]

      try {
        routes = parse(container, config.network, fields)
      }
      catch (error) {
        skipped.push({ container: container.name, host: fields.get('host'), reason: `route ${name}: ${error instanceof Error ? error.message : String(error)}` })

        continue
      }

      for (const route of routes) {
        const entry = { route, where: `container ${container.name}` }

        try {
          checkRoutes([...kept, entry])
        }
        catch (error) {
          skipped.push({ container: container.name, host: route.host, reason: error instanceof Error ? error.message : String(error) })

          continue
        }

        kept.push(entry)
        groups.set(groupOf(container), [...groups.get(groupOf(container)) ?? [], route])
      }
    }
  }

  return { groups: [...groups].map(([name, routes]) => ({ name, routes })), skipped }
}
