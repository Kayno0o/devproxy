import type { Certs } from '../src/apply'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { apply, dropGroup, readGroups, saveGroup } from '../src/apply'
import { resolved, ROUTES } from './fixtures'

let dir: string
let made: string[][]

// Stands in for mkcert: writes placeholder files and records the hosts each certificate was asked for.
const certs: Certs = {
  make(hosts, cert, key) {
    made.push(hosts)
    writeFileSync(cert, 'cert')
    writeFileSync(key, 'key')
  },
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devproxy-'))
  made = []
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('apply', () => {
  test('writes every file, and nothing on a second run', () => {
    const config = resolved(dir)

    expect(apply(config, certs).changed).toEqual(['certs/main.pem', 'nginx/nginx.conf', 'nginx/sni.conf', 'nginx/main.conf'])
    expect(made).toEqual([['*.tenant.localhost', 'app.localhost', 'docs.localhost', 'localhost', 'site.localhost']])
    expect(apply(config, certs)).toEqual({ changed: [], removed: [] })
    expect(made).toHaveLength(1)
  })

  test('the main certificate is made again only when its hosts change', () => {
    apply(resolved(dir), certs)
    apply(resolved(dir, [...ROUTES, { host: 'new.localhost', to: 'http://new:80' }]), certs)

    expect(made).toHaveLength(2)
    expect(made[1]).toContain('new.localhost')
  })

  test('a group gets its files and certificate, and loses them once removed', () => {
    const config = resolved(dir)

    saveGroup(config, { name: 'wt-app-x', routes: [{ host: 'x.app.localhost', to: 'http://wt-app-x-app-1:3000' }, { host: 'x.api.localhost', to: 'wt-x-nginx-1:443', passthrough: true }] })

    expect(apply(config, certs).changed).toContain('nginx/http/wt-app-x.conf')
    expect(made.at(-1)).toEqual(['x.app.localhost'])
    expect(readFileSync(join(dir, 'nginx/sni/wt-app-x.conf'), 'utf8')).toContain('x.api.localhost wt-x-nginx-1:443;')
    expect(readFileSync(join(dir, 'nginx/http/wt-app-x.conf'), 'utf8')).toContain(`ssl_certificate     ${dir}/certs/wt-app-x.pem;`)

    expect(dropGroup(config, 'wt-app-x')).toBe(true)
    expect(apply(config, certs).removed.sort()).toEqual(['certs/wt-app-x-key.pem', 'certs/wt-app-x.hosts', 'certs/wt-app-x.pem', 'nginx/http/wt-app-x.conf', 'nginx/sni/wt-app-x.conf'])
    expect(readdirSync(join(dir, 'certs')).sort()).toEqual(['main-key.pem', 'main.hosts', 'main.pem'])
    expect(dropGroup(config, 'wt-app-x')).toBe(false)
  })

  test('a group may not take a host already routed, nor be named main', () => {
    const config = resolved(dir)

    expect(() => saveGroup(config, { name: 'other', routes: [{ host: 'app.localhost', to: 'http://x:1' }] })).toThrow('app.localhost is routed twice, by the config and group other')
    expect(() => saveGroup(config, { name: 'main', routes: [] })).toThrow('is not a group name')
    expect(() => saveGroup(config, { name: '../x', routes: [] })).toThrow('is not a group name')
    expect(existsSync(join(dir, 'groups'))).toBe(false)
  })

  test('a group replaced keeps one file', () => {
    const config = resolved(dir)

    saveGroup(config, { name: 'g', routes: [{ host: 'a.localhost', to: 'http://a:1' }] })
    saveGroup(config, { name: 'g', routes: [{ host: 'b.localhost', to: 'http://b:1' }] })

    expect(readGroups(config)).toEqual([{ name: 'g', routes: [{ host: 'b.localhost', to: 'http://b:1' }] }])
  })
})
