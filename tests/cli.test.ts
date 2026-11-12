import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
let home: string

// PATH holds only bun's folder, so no docker answers and the proxy reads as not running unless a test writes a docker stub; mkcert is a stub writing placeholder files.
function devproxy(args: string[], stdin?: string, extraEnv: Record<string, string> = {}) {
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: `${join(home, 'bin')}:${process.execPath.replace(/\/[^/]+$/, '')}`, ...extraEnv }
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

  // A docker whose proxy runs or not, and whose `compose up` (re)starts one that writes the given verdict as the entrypoint does, or leaves the proxy as it is.
  function docker(running: boolean, verdict?: string) {
    const status = join(home, 'state/nginx/.status')
    const compose = verdict === undefined ? ':' : `printf '%s\\n' '${verdict}' > '${status}'`

    writeFileSync(join(home, 'bin/docker'), `#!/bin/sh\ncase "$1" in\n  inspect) [ "$2" = network ] || echo ${running};;\n  compose) ${compose};;\nesac\n`, { mode: 0o755 })
  }

  const dockerStartingWith = (verdict: string) => docker(false, verdict)

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

  test('up on a running proxy with nothing new reports the verdict it holds', () => {
    const config = join(home, 'proxy.ts')

    writeFileSync(config, `export default { dir: './state', labels: false }\n`)
    dockerStartingWith('error 2026-01-01T00:00:00Z\nunknown directive "bogus"')
    devproxy(['up', '-c', config])
    docker(true)

    const run = devproxy(['up', '-c', config])

    expect(run.code).toBe(1)
    expect(run.err).toContain('keeps serving the last one it accepted')
    expect(run.err).toContain('unknown directive "bogus"')
  })

  test('up names its own compose project, so a COMPOSE_PROJECT_NAME from the caller cannot point compose elsewhere', () => {
    const config = join(home, 'proxy.ts')
    const calls = join(home, 'compose-calls')

    writeFileSync(config, `export default { dir: './state', name: 'test-proxy', labels: false }\n`)
    const status = join(home, 'state/nginx/.status')

    writeFileSync(join(home, 'bin/docker'), `#!/bin/sh\ncase "$1" in\n  inspect) [ "$2" = network ] || echo false;;\n  compose) echo "$@" >> '${calls}'; printf 'ok 2026-01-01T00:00:00Z\\n' > '${status}';;\nesac\n`, { mode: 0o755 })

    expect(devproxy(['up', '-c', config], undefined, { COMPOSE_PROJECT_NAME: 'shop--feature' }).code).toBe(0)
    expect(readFileSync(calls, 'utf8')).toContain('compose -p test-proxy -f ')
  })

  test('up after a ports change waits for the recreated proxy, not for nginx to answer a compose file it never reads', () => {
    const config = join(home, 'proxy.ts')

    writeFileSync(config, `export default { dir: './state', labels: false }\n`)
    dockerStartingWith('ok 2026-01-01T00:00:00Z')
    expect(devproxy(['up', '-c', config]).code).toBe(0)

    writeFileSync(config, `export default { dir: './state', labels: false, ports: { http: 8080 } }\n`)
    docker(true, 'error 2026-01-01T00:00:00Z\nbind() to 0.0.0.0:80 failed')

    const run = devproxy(['up', '-c', config])

    expect(run.code).toBe(1)
    expect(run.err).toContain('serves nothing until it is fixed')
    expect(run.err).toContain('bind() to 0.0.0.0:80 failed')
  }, 30_000)

  test('set refuses invalid routes with a usage error and registers nothing', () => {
    const config = join(home, 'proxy.ts')

    writeFileSync(config, `export default { dir: './state' }\n`)

    const run = devproxy(['set', 'bad', '-c', config], JSON.stringify({ routes: [{ host: 'x.localhost', to: 'nope' }] }))

    expect(run.code).toBe(2)
    expect(existsSync(join(home, 'state/groups/bad.json'))).toBe(false)
  })
})
