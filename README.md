# devproxy

A local HTTPS reverse proxy for docker compose stacks. One nginx container holds ports 80 and 443 and sends each `*.localhost` host to its stack, with certificates your browser trusts. You describe the routes in one config file and devproxy generates nginx's config, the SNI map, the compose file and the mkcert certificates from it.

Requires Linux or macOS with docker, bun 1.4.3+ and [mkcert](https://github.com/FiloSottile/mkcert) (run `mkcert -install` once).

```sh
bun add -g @kaynooo/devproxy --registry https://git.kaynooo.fr/api/packages/kaynooo/npm/
devproxy init        # writes ~/.config/devproxy/config.ts
devproxy up
```

## Config

```ts
export default {
  name: 'devproxy',          // container and compose project
  dir: '~/.local/share/devproxy', // generated nginx config, certificates, logs
  network: 'devproxy',       // the docker network shared with your stacks
  ports: { http: 80, https: 443 },
  routes: [
    { host: 'app.localhost', to: 'http://app:3000', buffering: false },
    { host: 'docs.localhost', to: 'host:5173' },
    { host: '*.tenant.localhost', to: 'http://tenant:80' },
    { host: 'api.localhost', to: 'api-nginx:443', passthrough: true },
    {
      host: 'site.localhost',
      to: 'http://site:4321',
      lines: ['client_max_body_size 50m;'],
      locations: [{ path: '/api/', to: 'https://api.example.com' }, { path: '~ ^/admin/?$', redirect: 'https://admin.localhost/' }],
    },
  ],
}
```

- `to` is a container on the shared network (`http://app:3000`), or `host:<port>` for a port on this machine. A container is resolved per request, so the proxy starts while that stack is down.
- `passthrough` hands the TLS stream untouched to an upstream holding its own certificate, chosen by SNI.
- `buffering: false` is for server-sent events. `keepaliveRequests`, `locations` and raw `lines` cover the rest.
- `import { defineConfig } from '@kaynooo/devproxy'` types the file where the package resolves.

A stack joins the network in its own compose file. nginx dials containers by name, so give a service named `nginx` or `php` a unique alias there:

```yaml
services:
  nginx:
    networks:
      default:
      devproxy:
        aliases: [myapp-nginx]
networks:
  devproxy:
    external: true
```

## Commands

`devproxy apply` generates everything again and waits until the running nginx has tested and loaded it. A config nginx refuses never replaces the one it serves: `devproxy status` shows why.

Other tools register routes as named groups, with the same fields as the config's routes:

```sh
echo '{"routes":[{"host":"feat.app.localhost","to":"http://feat-app-1:3000"}]}' | devproxy set wt-app-feat
devproxy rm wt-app-feat
devproxy hosts --json
```

A group gets its own certificate, and its hosts come before the config's in the SNI map, so `*.feat.client.localhost` wins over `*.client.localhost`.
