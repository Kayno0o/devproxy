import type { Route } from '../src/config'
import { describe, expect, test } from 'bun:test'
import { resolveConfig } from '../src/config'
import { renderCompose, renderGroupSni, renderHttp, renderNginx, renderSni } from '../src/render'
import { resolved, ROUTES } from './fixtures'

describe('resolveConfig', () => {
  test('fills the defaults and resolves dir against the config folder', () => {
    expect(resolveConfig({ dir: 'state' }, '/etc/devproxy')).toEqual({ name: 'devproxy', dir: '/etc/devproxy/state', network: 'devproxy', ports: { http: 80, https: 443 }, image: 'nginx:alpine', routes: [] })
  })

  test.each([
    [{ host: 'App.localhost', to: 'http://app:3000' }, 'is not a host name'],
    [{ host: 'app.localhost', to: 'ftp://app' }, 'not an http or https URL'],
    [{ host: 'app.localhost', to: 'http://app:3000/base' }, 'carries a path'],
    [{ host: 'app.localhost', to: 'http://app:3000', passthrough: true }, 'goes to name:port'],
    [{ host: 'app.localhost', to: 'app:443', passthrough: true, buffering: false }, 'never sees HTTP'],
    [{ host: 'app.localhost', to: 'http://app:3000', locations: [{ path: '/x' }] }, 'needs either to or redirect'],
  ] as [Route, string][])('refuses %o', (route, message) => {
    expect(() => resolveConfig({ dir: '/x', routes: [route] }, '/')).toThrow(message)
  })

  test('refuses a host routed twice', () => {
    expect(() => resolveConfig({ dir: '/x', routes: [ROUTES[0]!, ROUTES[0]!] }, '/')).toThrow('app.localhost is routed twice')
  })
})

describe('render', () => {
  const config = resolved('/srv/proxy')

  test('a container upstream resolves per request, a host port statically', () => {
    const http = renderHttp(config, { name: 'main', routes: config.routes })

    expect(http).toContain('set $upstream http://app:3000;\n        proxy_pass $upstream$request_uri;')
    expect(http).toContain('proxy_pass http://host.docker.internal:5173;')
    expect(http).toContain('keepalive_requests 100000;')
    expect(http).toContain('proxy_buffering off;')
    expect(http).toContain('ssl_certificate     /srv/proxy/certs/main.pem;')
  })

  test('locations come before /, with their own lines, redirects and https upstreams', () => {
    const http = renderHttp(config, { name: 'main', routes: config.routes })
    const site = http.slice(http.indexOf('server_name site.localhost'))

    expect(site.indexOf('location /api/')).toBeLessThan(site.indexOf('location / {'))
    expect(site).toContain('client_max_body_size 50m;')
    expect(site).toContain('proxy_ssl_server_name on;\n        proxy_read_timeout 600s;\n        proxy_set_header Origin "";')
    expect(site).toContain('location ~ ^/admin/?$ {\n        return 302 https://admin.localhost/$is_args$args;')
  })

  test('passthrough routes only reach the SNI map, wildcards as regexes', () => {
    expect(renderHttp(config, { name: 'main', routes: config.routes })).not.toContain('api.localhost')
    expect(renderSni(config)).toContain('    api.localhost api-nginx:443;\n    ~^.+\\.client\\.localhost$ api-nginx:443;\n    default 127.0.0.1:8443;')
  })

  test('the groups\' SNI entries are included before the main ones', () => {
    const sni = renderSni(config)

    expect(sni.indexOf('include /srv/proxy/nginx/sni/*.conf;')).toBeLessThan(sni.indexOf('api.localhost'))
    expect(renderGroupSni({ name: 'wt-x', routes: [{ host: 'x.api.localhost', to: 'x-nginx:443', passthrough: true }] })).toContain('x.api.localhost x-nginx:443;')
  })

  test('nginx.conf and compose point at the configured folder, name, ports and network', () => {
    expect(renderNginx(config)).toContain('include /srv/proxy/nginx/main.conf;\n    include /srv/proxy/nginx/http/*.conf;')
    expect(renderCompose({ ...config, ports: { http: 8080, https: 8443 } })).toContain('container_name: devproxy-test\n')
    expect(renderCompose({ ...config, ports: { http: 8080, https: 8443 } })).toContain('- "8080:80"\n      - "8443:443"')
    expect(renderCompose(config)).toContain('- /srv/proxy:/srv/proxy\n    networks:\n      - devproxy-test')
  })
})
