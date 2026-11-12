import type { Certs } from '../src/apply'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { apply } from '../src/apply'
import { paths } from '../src/render'
import { resolved } from './fixtures'

// The entrypoint runs in the image the proxy uses; skipped where docker or openssl is missing.
const usable = Bun.which('docker') !== null && Bun.which('openssl') !== null && Bun.spawnSync(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
const dir = mkdtempSync(join(tmpdir(), 'devproxy-entrypoint-'))
const container = `devproxy-entrypoint-test-${process.pid}`

afterAll(() => {
  if (usable)
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' })
  rmSync(dir, { recursive: true, force: true })
})

const selfSigned: Certs = {
  make(hosts, cert, key) {
    const run = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${hosts[0]}`, '-keyout', key, '-out', cert], { stdout: 'ignore', stderr: 'pipe' })

    if (run.exitCode !== 0)
      throw new Error(run.stderr.toString())
  },
}

async function verdict(status: string, expected: string): Promise<string> {
  const deadline = Date.now() + 20_000
  let last = ''

  while (Date.now() < deadline) {
    try {
      last = readFileSync(status, 'utf8')
    }
    catch {}

    if (last.startsWith(expected))
      return last

    await Bun.sleep(100)
  }

  return last
}

test.skipIf(!usable)('a change keeping a file\'s size and mtime second is still tested', async () => {
  const config = resolved(dir)
  const extra = join(dir, 'nginx', 'http', 'zz-extra.conf')
  const status = join(dir, 'nginx', '.status')

  apply(config, selfSigned)
  mkdirSync(join(dir, 'nginx', 'http'), { recursive: true })
  writeFileSync(extra, '# fine\n')

  const { atime, mtime } = statSync(extra)
  const run = Bun.spawnSync(['docker', 'run', '-d', '--name', container, '--add-host', 'host.docker.internal:host-gateway', '-v', `${dir}:${dir}`, '-v', `${join(import.meta.dir, '../src/entrypoint.sh')}:/devproxy-entrypoint.sh:ro`, '-e', `DEVPROXY_CONF=${join(dir, paths.nginx)}`, '-e', 'DEVPROXY_POLL_INTERVAL=1', '--entrypoint', 'sh', config.image, '/devproxy-entrypoint.sh'], { stdout: 'pipe', stderr: 'pipe' })

  expect(run.exitCode, run.stderr.toString()).toBe(0)
  expect(await verdict(status, 'ok')).toStartWith('ok')
  // One poll round, so the entrypoint has fingerprinted the first version.
  await Bun.sleep(1500)

  // Same size, same mtime: only the content tells the two apart.
  writeFileSync(extra, 'bogus;\n')
  utimesSync(extra, atime, mtime)

  expect(await verdict(status, 'error')).toContain('unknown directive "bogus"')
}, 120_000)
