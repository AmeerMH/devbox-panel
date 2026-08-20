import test from 'node:test'
import assert from 'node:assert/strict'
import { parseVhost } from '../src/services/nginx.js'

const VHOST = `
# This block used to proxy_pass http://127.0.0.1:9999; — kept for history
# server_name old.example.com;
map $host $dev_upstream {
    default 0;
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl;
    server_name example.com www.example.com *.example.com;
    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    allow 100.64.0.0/10;
    deny all;
    location / { proxy_pass http://127.0.0.1:3100; }
}
`

test('reads server names, listens and upstreams, inline blocks included', () => {
  const v = parseVhost(VHOST)
  assert.deepEqual(v.serverNames, ['example.com', 'www.example.com', '*.example.com'])
  assert.deepEqual(v.proxyPass, ['http://127.0.0.1:3100'])
  assert.deepEqual(v.upstreamPorts, ['3100'])
  assert.equal(v.listens.length, 2)
  assert.equal(v.ssl, true)
  assert.equal(v.restricted, true)
})

test('ignores commented-out directives', () => {
  const v = parseVhost(VHOST)
  assert.ok(!v.serverNames.includes('old.example.com'))
  assert.ok(!v.upstreamPorts.includes('9999'))
})

test('an unrestricted vhost is reported as such', () => {
  const v = parseVhost('server { listen 80; server_name a.test; location / { proxy_pass http://127.0.0.1:1234; } }')
  assert.equal(v.restricted, false)
  assert.equal(v.ssl, false)
  assert.deepEqual(v.upstreamPorts, ['1234'])
})
