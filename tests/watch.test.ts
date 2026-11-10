import type { Certs } from '../src/apply'
import type { Resolved } from '../src/config'
import type { Container } from '../src/labels'
import type { LabelSources } from '../src/runtime'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readLabelReport, readSnapshot, writeRuntime, writeSnapshot } from '../src/apply'
import { syncLabels, watch } from '../src/runtime'
import { resolved } from './fixtures'

const certs: Certs = {
  make(_hosts, cert, key) {
    writeFileSync(cert, 'cert')
    writeFileSync(key, 'key')
  },
}

const shop: Container = { name: 'shop-app-1', project: 'shop', labels: { 'devproxy.web.host': 'shop.localhost' }, networks: ['devproxy-test'] }

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devproxy-watch-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

// The watch service's view: the snapshot the host wrote, read again on every pass.
function sources(containers: () => Promise<Container[]>, events: LabelSources['events'] = async () => Bun.sleep(10_000)): LabelSources {
  return { config: async () => readSnapshot(dir), containers, events, certs, verdictMs: 50, retryMs: 50 }
}

async function until(done: () => boolean) {
  for (let tries = 0; tries < 100 && !done(); tries++)
    await Bun.sleep(20)
}

describe('syncLabels', () => {
  test('serves the labelled stack beside routes the host applied after the service started', async () => {
    const config = resolved(dir, [{ host: 'app.localhost', to: 'http://app:3000' }])

    writeSnapshot(config)
    await syncLabels(dir, sources(async () => [shop]))
    writeSnapshot({ ...config, routes: [...config.routes, { host: 'new.localhost', to: 'http://new:80' }] })
    await syncLabels(dir, sources(async () => [shop]))

    expect(readFileSync(join(dir, 'nginx/main.conf'), 'utf8')).toContain('server_name new.localhost;')
    expect(readFileSync(join(dir, 'nginx/http/docker-shop.conf'), 'utf8')).toContain('set $upstream http://shop-app-1;')
    expect(readLabelReport(config)).toMatchObject({ groups: ['docker-shop'], skipped: [] })
  })

  test('writes no group once labels are turned off', async () => {
    writeSnapshot({ ...resolved(dir), labels: false })
    await syncLabels(dir, sources(async () => [shop]))

    expect(existsSync(join(dir, 'groups/docker-shop.json'))).toBe(false)
  })

  test('finishes a pass that wrote the groups but not nginx\'s files', async () => {
    writeSnapshot(resolved(dir))
    await syncLabels(dir, sources(async () => [shop]))
    rmSync(join(dir, 'nginx/http/docker-shop.conf'))
    await syncLabels(dir, sources(async () => [shop]))

    expect(existsSync(join(dir, 'nginx/http/docker-shop.conf'))).toBe(true)
  })
})

describe('watch', () => {
  test('syncs on start and on events, and retries a pass that failed', async () => {
    const stop = new AbortController()
    let calls = 0
    let emit: (() => void) | undefined
    const containers = async () => {
      calls++

      if (calls === 1)
        throw new Error('docker is restarting')

      return calls === 2 ? [shop] : []
    }
    const events: LabelSources['events'] = async (changed, signal) => {
      emit = changed
      await new Promise(resolve => signal?.addEventListener('abort', resolve))
    }

    writeSnapshot(resolved(dir))

    const running = watch(dir, sources(containers, events), stop.signal)

    await until(() => existsSync(join(dir, 'groups/docker-shop.json')))
    expect(existsSync(join(dir, 'groups/docker-shop.json'))).toBe(true)

    emit?.()
    await until(() => !existsSync(join(dir, 'groups/docker-shop.json')))
    expect(existsSync(join(dir, 'groups/docker-shop.json'))).toBe(false)

    stop.abort()
    await running
  })
})

describe('writeRuntime', () => {
  test('writes the compose file and the entrypoint; the snapshot reads back as the config', () => {
    const config: Resolved = resolved(dir)

    expect(writeRuntime(config, undefined)).toEqual(['compose.yml', 'entrypoint.sh'])
    expect(writeRuntime(config, undefined)).toEqual([])
    writeSnapshot(config)
    expect(readSnapshot(dir)).toEqual(config)
  })
})
