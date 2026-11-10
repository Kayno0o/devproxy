import type { Certs } from '../src/apply'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { apply, saveGroup } from '../src/apply'
import { paths } from '../src/render'
import { resolved } from './fixtures'

// nginx itself judges what the renderer writes, in the image the proxy runs; skipped where docker or openssl is missing.
const usable = Bun.which('docker') !== null && Bun.which('openssl') !== null && Bun.spawnSync(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
const dir = mkdtempSync(join(tmpdir(), 'devproxy-nginx-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const selfSigned: Certs = {
  make(hosts, cert, key) {
    const run = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${hosts[0]}`, '-keyout', key, '-out', cert], { stdout: 'ignore', stderr: 'pipe' })

    if (run.exitCode !== 0)
      throw new Error(run.stderr.toString())
  },
}

test.skipIf(!usable)('nginx -t accepts a config holding every route kind and a group', () => {
  const config = resolved(dir)

  saveGroup(config, { name: 'wt-app-x', routes: [{ host: 'x.app.localhost', to: 'http://wt-app-x-app-1:3000' }, { host: '*.x.client.localhost', to: 'wt-x-nginx-1:443', passthrough: true }] })
  apply(config, selfSigned)

  const run = Bun.spawnSync(['docker', 'run', '--rm', '--add-host', 'host.docker.internal:host-gateway', '-v', `${dir}:${dir}`, config.image, 'nginx', '-t', '-c', join(dir, paths.nginx)], { stdout: 'pipe', stderr: 'pipe' })

  expect(run.stderr.toString()).toContain('test is successful')
  expect(run.exitCode).toBe(0)
}, 120_000)
