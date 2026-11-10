import type { Container } from './labels'
import process from 'node:process'

const UNIX = /^unix:\/\//
const LEADING_SLASH = /^\//

// The docker engine's socket, from DOCKER_HOST when it names one.
export const dockerSocket = (): string => UNIX.test(process.env.DOCKER_HOST ?? '') ? process.env.DOCKER_HOST!.replace(UNIX, '') : '/var/run/docker.sock'

interface ApiContainer {
  Names: string[]
  Labels: Record<string, string> | null
  NetworkSettings: { Networks: Record<string, unknown> | null }
}

async function api(path: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`http://docker${path}`, { unix: dockerSocket(), signal: signal ?? null })

  if (!response.ok)
    throw new Error(`docker ${path}: ${response.status} ${(await response.text()).trim()}`)

  return response
}

export async function runningContainers(): Promise<Container[]> {
  const list = await (await api('/containers/json')).json() as ApiContainer[]

  return list.map(container => ({
    name: (container.Names[0] ?? '').replace(LEADING_SLASH, ''),
    project: container.Labels?.['com.docker.compose.project'],
    labels: container.Labels ?? {},
    networks: Object.keys(container.NetworkSettings.Networks ?? {}),
  }))
}

const EVENTS = { type: ['container', 'network'], event: ['start', 'die', 'destroy', 'connect', 'disconnect'] }

// Calls `changed` on every container start or stop and network (dis)connection until the stream ends, which it returns on.
export async function followEvents(changed: () => void, signal?: AbortSignal): Promise<void> {
  const response = await api(`/events?filters=${encodeURIComponent(JSON.stringify(EVENTS))}`, signal)
  const decoder = new TextDecoder()

  for await (const chunk of response.body! as AsyncIterable<Uint8Array>) {
    if (decoder.decode(chunk, { stream: true }).includes('\n'))
      changed()
  }
}
