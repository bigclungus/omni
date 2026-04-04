# channel-o2o

Omni-to-omni: connect **two gateway instances** so one can push work to the other over HTTP.

Each instance has its own config (`omni.yaml`), HTTP port, SQLite DB, and IPC socket. One process runs an **orchestrator** MCP client; the other runs a **worker** MCP client. They never share a socket.

## Flow

1. **Ingress** — On the worker gateway, define a channel with `ingressSecret`. The orchestrator POSTs JSON to `http://<worker-host>:<port>/o2o/<channelId>` with header `Authorization: Bearer <ingressSecret>`. The event is queued and delivered to that gateway’s MCP clients (same path as webhooks).

2. **Egress** — On the orchestrator gateway, define a channel with `peerUrl` pointing at that worker URL (and optional `headers`, `timeoutMs`). Call `omni_dispatch` with capability **`send`**: JSON **`payload`** (object or JSON string), optional **`taskId`**, **`pathSuffix`** (append to the configured URL path), **`contentType`** (default `application/json`). The gateway POSTs to the peer.

Use the **same shared secret** in the egress channel’s `headers` (e.g. `Authorization: Bearer …`) and the ingress channel’s `ingressSecret`.

## Config keys

| Key | Use |
|-----|-----|
| `peerUrl` | Egress: full URL for `send` (POST body = JSON). |
| `headers` | Egress: extra request headers (often auth). |
| `timeoutMs` | Egress: request timeout (default 60000). |
| `ingressSecret` | Ingress: required Bearer token for `/o2o/:channelId`. |

A single channel row may include both `peerUrl` and `ingressSecret` if that process both sends and receives.

## Examples

Orchestrator gateway (egress only):

```yaml
channels:
  delegate_to_worker:
    plugin: channel-o2o
    peerUrl: http://127.0.0.1:8086/o2o/worker_inbox
    timeoutMs: 120000
    headers:
      Authorization: Bearer your-shared-secret
```

Worker gateway (ingress only):

```yaml
channels:
  worker_inbox:
    plugin: channel-o2o
    ingressSecret: your-shared-secret
```

More commented options: repo root `omni.yaml.example`.
