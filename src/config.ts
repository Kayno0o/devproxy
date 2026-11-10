import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

export interface Location {
  // An nginx location argument as written in a `location` block: `/api/`, `= /health` or `~ ^/admin/?$`.
  path: string
  // The upstream URL; `host:<port>` stands for a port on the machine running the proxy.
  to?: string
  // An address answered with a 302, the query string kept.
  redirect?: string
  buffering?: boolean
  // Raw nginx lines added inside the location, after the generated ones.
  lines?: string[]
  comment?: string
}

export interface Route {
  // `app.localhost`, or `*.app.localhost` for every subdomain.
  host: string
  // The upstream URL (`http://app:3000`, `host:3000`), or with `passthrough` the `name:port` that receives the TLS stream as is.
  to: string
  // Hands the encrypted stream to an upstream holding its own certificate, chosen by SNI.
  passthrough?: boolean
  // False sets `proxy_buffering off`, which server-sent events need.
  buffering?: boolean
  keepaliveRequests?: number
  // Locations served before `/`, which goes to `to`.
  locations?: Location[]
  // Raw nginx lines added to the server block.
  lines?: string[]
  comment?: string
}

export interface Config {
  // The compose project and container name.
  name?: string
  // Where devproxy keeps what it generates, its certificates and the logs; relative to the config file.
  dir: string
  // The docker network the proxy shares with the stacks it reaches.
  network?: string
  ports?: { http?: number, https?: number }
  image?: string
  // False leaves the watch service out, and with it the routes declared as container labels.
  labels?: boolean
  // The image the watch service runs devproxy in.
  watchImage?: string
  routes?: Route[]
}

export interface Resolved {
  name: string
  dir: string
  network: string
  ports: { http: number, https: number }
  image: string
  labels: boolean
  watchImage: string
  routes: Route[]
}

export const defineConfig = (config: Config): Config => config

const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const NAME = /^[a-z0-9][\w.-]*$/
const PASSTHROUGH_TARGET = /^[\w.-]+:\d+$/
const HOST_PORT = /^host:(\d+)$/

// The upstream as nginx dials it: `host:<port>` becomes the host machine as the container sees it.
export function upstreamUrl(to: string): URL {
  const port = HOST_PORT.exec(to)?.[1]
  const url = new URL(port === undefined ? to : `http://host.docker.internal:${port}`)

  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`${to} is not an http or https URL`)

  if (url.pathname !== '/' || url.search !== '')
    throw new Error(`${to} carries a path, which the proxy would not forward as written: route the path with a location`)

  return url
}

function checkRoute(route: Route, where: string) {
  if (!HOST.test(route.host))
    throw new Error(`${where}: ${route.host} is not a host name`)

  if (route.passthrough === true) {
    if (!PASSTHROUGH_TARGET.test(route.to))
      throw new Error(`${where}: a passthrough route goes to name:port, not ${route.to}`)

    if (route.locations !== undefined || route.lines !== undefined || route.buffering !== undefined || route.keepaliveRequests !== undefined)
      throw new Error(`${where}: a passthrough route never sees HTTP, so it takes no locations, lines, buffering or keepaliveRequests`)

    return
  }

  upstreamUrl(route.to)

  for (const location of route.locations ?? []) {
    if ((location.to === undefined) === (location.redirect === undefined))
      throw new Error(`${where}: location ${location.path} needs either to or redirect`)

    if (location.to !== undefined)
      upstreamUrl(location.to)
  }
}

// Every host appears once across the main routes and the groups, since nginx would serve only the first.
export function checkRoutes(routes: { route: Route, where: string }[]) {
  const seen = new Map<string, string>()

  for (const { route, where } of routes) {
    checkRoute(route, where)

    const before = seen.get(route.host)

    if (before !== undefined)
      throw new Error(`${route.host} is routed twice, by ${before} and ${where}`)

    seen.set(route.host, where)
  }
}

const expandHome = (path: string) => path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path

export function resolveConfig(config: Config, configDir: string): Resolved {
  const name = config.name ?? 'devproxy'

  if (!NAME.test(name))
    throw new Error(`name ${name} is not a valid compose project name`)

  const dir = expandHome(config.dir)
  const routes = config.routes ?? []

  checkRoutes(routes.map(route => ({ route, where: 'the config' })))

  return {
    name,
    dir: isAbsolute(dir) ? dir : resolve(configDir, dir),
    network: config.network ?? 'devproxy',
    ports: { http: config.ports?.http ?? 80, https: config.ports?.https ?? 443 },
    image: config.image ?? 'nginx:alpine',
    labels: config.labels ?? true,
    watchImage: config.watchImage ?? 'oven/bun:1.4.4-alpine',
    routes,
  }
}
