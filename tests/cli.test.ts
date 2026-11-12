import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
let home: string

// PATH holds only bun's folder, so no docker answers and the proxy reads as not running; mkcert is a stub writing placeholder files.
function devproxy(args: string[], stdin?: string) {
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: `${join(home, 'bin')}:${process.execPath.replace(/\/[^/]+$/, '')}` }
  const run = Bun.spawnSync([process.execPath, CLI, ...args], { env, stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe' })

  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'devproxy-cli-'))

  const bin = join(home, 'bin')
  const stub = join(bin, 'mkcert')

  Bun.spawnSync(['mkdir', '-p', bin])
  writeFileSync(stub, '#!/bin/sh\nwhile [ $# -gt 0 ]; do case $1 in -cert-file) echo cert > "$2"; shift 2;; -key-file) echo key > "$2"; shift 2;; *) shift;; esac; done\n', { mode: 0o755 })
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('devproxy', () => {
  test('without a config, says how to write one', () => {
    const run = devproxy(['hosts'])

    expect(run.code).toBe(1)
    expect(run.err).toContain('devproxy init')
  })

  test('init writes a starter that loads, and never overwrites it', () => {
    expect(devproxy(['init']).code).toBe(0)
    expect(devproxy(['hosts', '--json']).out).toBe('[]\n')
    expect(devproxy(['init']).code).toBe(1)
  })

  test('set, hosts and rm manage a group on top of the config', () => {
    const config = join(home, 'proxy.ts')

    writeFileSync(config, `export default { dir: './state', routes: [{ host: 'app.localhost', to: 'http://app:3000' }] }\n`)

    const set = devproxy(['set', 'wt-x', '-c', config], JSON.stringify({ routes: [{ host: 'x.api.localhost', to: 'x-nginx-1:443', passthrough: true }] }))

    expect(set.code).toBe(0)
    expect(set.out).toContain('the proxy is not running')
    expect(readFileSync(join(home, 'state/nginx/sni/wt-x.conf'), 'utf8')).toContain('x.api.localhost x-nginx-1:443;')
    expect(JSON.parse(devproxy(['hosts', '--json', '-c', config]).out)).toEqual([
      { host: 'app.localhost', group: null, to: 'http://app:3000', passthrough: false },
      { host: 'x.api.localhost', group: 'wt-x', to: 'x-nginx-1:443', passthrough: true },
    ])

    expect(devproxy(['rm', 'wt-x', '-c', config]).code).toBe(0)
    expect(existsSync(join(home, 'state/nginx/sni/wt-x.conf'))).toBe(false)
  })

  test('apply with labels off drops the groups the watch service left', () => {
    const config = join(home, 'proxy.ts')

    writeFileSync(config, `export default { dir: './state', labels: false }\n`)
    Bun.spawnSync(['mkdir', '-p', join(home, 'state/groups')])
    writeFileSync(join(home, 'state/groups/docker-shop.json'), JSON.stringify({ routes: [{ host: 'shop.localhost', to: 'http://shop:80' }] }))

    expect(devproxy(['apply', '-c', config]).code).toBe(0)
    expect(existsSync(join(home, 'state/groups/docker-shop.json'))).toBe(false)
    expect(readFileSync(join(home, 'state/compose.yml'), 'utf8')).not.toContain('watch:')
  })

  // A docker whose proxy is stopped, and whose `compose up` starts one that writes the given verdict, as the entrypoint does.
  function dockerStartingWith(verdict: string) {
    const status = join(home, 'state/nginx/.status')

    writeFileSync(join(home, 'bin/docker'), `#!/bin/sh\ncase "$1" in\n  inspect) [ "$2" = network ] || echo false;;\n  compose) printf '%s\\n' '${verdict}' > '${status}';;\nesac\n`, { mode: 0o755 })
  }

  test('up exits 1 when nginx refuses the config it starts on', () => {
    const config = join(home, 'proxy.ts')

    writeFileSync(config, `export default { dir: './state', labels: false }\n`)
    dockerStartingWith('error 2026-01-01T00:00:00Z\nunknown directive "bogus"')

    const run = devproxy(['up', '-c', config])

    expect(run.code).toBe(1)
    expect(run.err).toContain('unknown directive "bogus"')
    expect(run.out).not.toContain('is up')
  })

  test('up says the proxy is up once nginx accepts the config', () => {
    const config = join(home, 'proxy.ts')

    writeFileSync(config, `export default { dir: './state', labels: false }\n`)
    dockerStartingWith('ok 2026-01-01T00:00:00Z')

    const run = devproxy(['up', '-c', config])

    expect(run.code).toBe(0)
    expect(run.out).toContain('is up on 80 and 443')
  })

  test('set refuses invalid routes with a usage error and registers nothing', () => {
    const config = join(home, 'proxy.ts')

    writeFileSync(config, `export default { dir: './state' }\n`)

    const run = devproxy(['set', 'bad', '-c', config], JSON.stringify({ routes: [{ host: 'x.localhost', to: 'nope' }] }))

    expect(run.code).toBe(2)
    expect(existsSync(join(home, 'state/groups/bad.json'))).toBe(false)
  })
})
