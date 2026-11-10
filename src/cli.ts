#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { downCommand, group, hosts, init, rm, status, upCommand, update } from './commands'

process.exitCode = await runCli({
  name: 'devproxy',
  about: 'a local HTTPS reverse proxy for docker compose stacks, generated from one config file',
  replaces: 'hand-written nginx vhosts, an SNI map edited by hand and a mkcert run per host',
  examples: [['devproxy up', 'generate the config and start the proxy'], ['devproxy hosts --json', 'every host it serves'], ['echo \'{"routes":[...]}\' | devproxy set wt-booki-planning', 'register a group of routes']],
  commands: {
    up: { run: upCommand, summary: 'generate everything from the config and start the proxy' },
    down: { run: downCommand, summary: 'stop the proxy' },
    apply: { run: update, summary: 'generate everything again and wait for nginx to accept it' },
    status: { run: status, summary: 'whether the proxy runs, and its last verdict on the config' },
    hosts: { run: hosts, summary: 'every host the proxy serves, with its group and upstream' },
    set: { run: group, summary: 'add or replace a group of routes, read as JSON on stdin or from a file' },
    rm: { run: rm, summary: 'remove a group of routes' },
    init: { run: init, summary: 'write a starter config' },
  },
})
