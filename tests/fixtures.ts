import type { Resolved, Route } from '../src/config'
import { resolveConfig } from '../src/config'

// One route of each kind the renderer knows.
export const ROUTES: Route[] = [
  { host: 'app.localhost', to: 'http://app:3000', buffering: false, comment: 'Nuxt dev server' },
  { host: 'docs.localhost', to: 'host:5173', keepaliveRequests: 100000 },
  {
    host: 'site.localhost',
    to: 'http://site:4321',
    lines: ['client_max_body_size 50m;'],
    locations: [
      { path: '/api/', to: 'https://api.example.com', lines: ['proxy_set_header Origin "";'] },
      { path: '~ ^/admin/?$', redirect: 'https://admin.localhost/' },
    ],
  },
  { host: '*.tenant.localhost', to: 'http://tenant:80' },
  { host: 'api.localhost', to: 'api-nginx:443', passthrough: true },
  { host: '*.client.localhost', to: 'api-nginx:443', passthrough: true },
]

export const resolved = (dir: string, routes: Route[] = ROUTES): Resolved => resolveConfig({ name: 'devproxy-test', dir, network: 'devproxy-test', routes }, dir)
