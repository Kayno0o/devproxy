import type { Container } from '../src/labels'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readGroups, readLabelReport, saveGroup, syncLabelGroups } from '../src/apply'
import { labelGroups } from '../src/labels'
import { resolved } from './fixtures'

const container = (name: string, labels: Record<string, string>, extra: Partial<Container> = {}): Container => ({ name, project: 'shop', labels, networks: ['devproxy-test'], ...extra })

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devproxy-labels-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('labelGroups', () => {
  test('every field becomes a route to the container itself, grouped by compose project', () => {
    const { groups, skipped } = labelGroups(resolved(dir), [], [
      container('shop-app-1', {
        'devproxy.web.host': 'shop.localhost, www.shop.localhost',
        'devproxy.web.port': '3000',
        'devproxy.web.buffering': 'false',
        'devproxy.web.keepalive': '1000',
        'devproxy.admin.host': 'admin.shop.localhost',
        'devproxy.admin.scheme': 'https',
        'devproxy.admin.port': '8443',
        'com.docker.compose.service': 'app',
      }),
      container('shop-nginx-1', { 'devproxy.api.host': 'api.shop.localhost', 'devproxy.api.passthrough': 'true' }),
      container('shop-mail-1', { 'devproxy.dev.host': 'dev.shop.localhost', 'devproxy.dev.to': 'host:5173' }, { networks: [] }),
      container('blog', { 'devproxy.x.host': 'blog.localhost' }, { project: undefined }),
    ])

    expect(skipped).toEqual([])
    expect(groups).toEqual([
      { name: 'docker-blog', routes: [{ host: 'blog.localhost', to: 'http://blog:80' }] },
      {
        name: 'docker-shop',
        routes: [
          { host: 'shop.localhost', to: 'http://shop-app-1:3000', buffering: false, keepaliveRequests: 1000 },
          { host: 'www.shop.localhost', to: 'http://shop-app-1:3000', buffering: false, keepaliveRequests: 1000 },
          { host: 'admin.shop.localhost', to: 'https://shop-app-1:8443' },
          { host: 'dev.shop.localhost', to: 'host:5173' },
          { host: 'api.shop.localhost', to: 'shop-nginx-1:443', passthrough: true },
        ],
      },
    ])
  })

  test('a bad label or a taken host skips that route alone, saying why', () => {
    const { groups, skipped } = labelGroups(resolved(dir), [{ name: 'wt-x', routes: [{ host: 'x.localhost', to: 'http://x:1' }] }], [
      container('a', {
        'devproxy.ok.host': 'ok.localhost',
        'devproxy.dup.host': 'app.localhost',
        'devproxy.set.host': 'x.localhost',
        'devproxy.port.host': 'p.localhost',
        'devproxy.port.port': 'eighty',
        'devproxy.both.host': 'b.localhost',
        'devproxy.both.to': 'http://b:1',
        'devproxy.both.port': '2',
        'devproxy.flag.host': 'f.localhost',
        'devproxy.flag.passthrough': 'yes',
        'devproxy.typo.hots': 't.localhost',
      }),
      container('off', { 'devproxy.web.host': 'off.localhost' }, { networks: ['bridge'] }),
    ])

    expect(groups).toEqual([{ name: 'docker-shop', routes: [{ host: 'ok.localhost', to: 'http://a:80' }] }])
    expect(skipped.map(entry => `${entry.container} ${entry.host ?? '-'}: ${entry.reason}`).sort()).toEqual([
      'a -: label devproxy.typo.hots is not devproxy.<route>.<host|port|scheme|to|passthrough|buffering|keepalive>',
      'a app.localhost: app.localhost is routed twice, by the config and container a',
      'a b.localhost: route both: to names the whole upstream, so it takes no port or scheme',
      'a f.localhost: route flag: passthrough is yes, not true or false',
      'a p.localhost: route port: port eighty is not a port number',
      'a x.localhost: x.localhost is routed twice, by group wt-x and container a',
      'off off.localhost: route web: the container is not on the devproxy-test network, so the proxy cannot reach it',
    ])
  })
})

describe('syncLabelGroups', () => {
  test('replaces the docker groups only, and records what was skipped', () => {
    const config = resolved(dir)

    saveGroup(config, { name: 'wt-x', routes: [{ host: 'x.localhost', to: 'http://x:1' }] })

    expect(syncLabelGroups(config, [{ name: 'docker-a', routes: [{ host: 'a.localhost', to: 'http://a:80' }] }], [])).toBe(true)
    expect(syncLabelGroups(config, [{ name: 'docker-a', routes: [{ host: 'a.localhost', to: 'http://a:80' }] }], [])).toBe(false)
    expect(syncLabelGroups(config, [], [{ container: 'b', host: 'b.localhost', reason: 'why' }])).toBe(true)

    expect(readGroups(config).map(group => group.name)).toEqual(['wt-x'])
    expect(readLabelReport(config)).toMatchObject({ groups: [], skipped: [{ container: 'b', host: 'b.localhost', reason: 'why' }] })
  })

  test('devproxy set may not take a docker- group', () => {
    expect(() => saveGroup(resolved(dir), { name: 'docker-a', routes: [] })).toThrow('nor starting with "docker-"')
    expect(() => readFileSync(join(dir, 'groups', 'docker-a.json'))).toThrow()
  })
})
