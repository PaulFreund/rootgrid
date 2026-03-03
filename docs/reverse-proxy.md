# Reverse proxy examples (nginx / Caddy)

Rootgrid is designed to run behind a reverse proxy for TLS termination.

Requirements:
- **SSE**: `/api/events` must stream (disable buffering)
- **WebSockets**:
  - `/v1/runner/ws` (runner control plane)
  - `/v1/tunnel` (VS Code tunnel)
  - `/vscode/*` (VS Code web viewer; HTTP + WS upgrades)
- **Uploads**: if you use attachments, allow large request bodies (v0: up to ~50MB per file; base64-in-JSON is larger on the wire)
- If you terminate TLS at the proxy, set `host.trustProxy=true` so Rootgrid can set **Secure** cookies when it sees
  `X-Forwarded-Proto: https`.

## nginx (example)

Notes:
- Keep `/api/events` unbuffered and with long read timeouts.
- Pass `Upgrade` headers for WebSocket routes.

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl;
  server_name rootgrid.example.com;

  # ... ssl_certificate / ssl_certificate_key ...
  # Allow large JSON bodies for attachments (tune to your needs).
  client_max_body_size 100m;

  # Default HTTP proxy (UI + REST)
  location / {
    proxy_pass http://127.0.0.1:7337;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  # SSE (no buffering)
  location /api/events {
    proxy_pass http://127.0.0.1:7337;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
  }

  # Runner + tunnel WebSockets
  location /v1/ {
    proxy_pass http://127.0.0.1:7337;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 1h;
  }

  # VS Code web viewer (HTTP + WS)
  location /vscode/ {
    proxy_pass http://127.0.0.1:7337;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 1h;
  }
}
```

## Caddy (example)

Caddy supports WebSockets automatically. For SSE, set a flush interval so events aren’t buffered.

```caddyfile
rootgrid.example.com {
  @sse path /api/events
  reverse_proxy @sse 127.0.0.1:7337 {
    flush_interval -1
  }

  reverse_proxy 127.0.0.1:7337
}
```
