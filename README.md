# Developer-Facing API Gateway

A production-style API gateway built to demonstrate real backend infrastructure:
JWT auth with refresh rotation, a Redis-backed rate limiter that holds up under
real concurrency, config-driven reverse proxying with a version-aware
rollback/circuit-breaker, Prometheus + Grafana monitoring, and a standalone Go
CLI used to prove the throughput claims.

## Architecture

```
                     ┌────────────────────────────────────┐
                     │   Clients: curl / Postman / Go      │
                     │   loadtest CLI                      │
                     └──────────────────┬───────────────────┘
                                        │ HTTP
                                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │                      GATEWAY (Node/TS)                    │
        │                                                           │
        │   requestId → pino JSON logs → metrics middleware         │
        │                                                           │
        │   /auth/*            /admin/*          /docs  /metrics    │
        │   register/login/    rollback control,  Swagger UI,       │
        │   refresh (JWT)       route status       Prometheus text  │
        │                                                           │
        │   /api/*  (proxied, config-driven from routes.yaml)       │
        │     resolveRoute → enforceRouteAuth (JWT) →                │
        │     rateLimit (GCRA / Redis Lua) → reverse proxy           │
        └───────────┬───────────────────────────────┬───────────────┘
                    │                               │
        ┌───────────▼───────────┐        ┌──────────▼───────────────┐
        │        Redis           │        │     Mock upstreams        │
        │  users, rate-limit      │        │  users / orders-v1 /       │
        │  buckets, rollback      │        │  orders-v2 (v2 seeded      │
        │  error windows          │        │  with a 60% error rate)    │
        └────────────────────────┘        └───────────────────────────┘

        ┌───────────────┐   scrapes   ┌───────────┐
        │  Prometheus    │◄────────────┤ /metrics  │
        └───────┬────────┘             └───────────┘
                │
                ▼
        ┌───────────────┐
        │    Grafana     │  (pre-provisioned dashboard)
        └───────────────┘
```

## Repo structure

```
gateway/            Node/TS gateway service (Express)
mock-upstreams/     One tiny configurable Express service, run 3x in
                    docker-compose as users / orders-v1 / orders-v2
loadtest/           Standalone Go module: concurrent load-test CLI
monitoring/         prometheus.yml + Grafana datasource/dashboard provisioning
postman/            Postman collection + environment
docker-compose.yml
DEPLOY.md           AWS EC2 deployment guide
```

## Quickstart

```bash
docker compose up -d --build
curl http://localhost:8080/health
```

That brings up: gateway (`:8080`), Redis (`:6379`), 3 mock upstreams
(`:4001-4003`), Prometheus (`:9090`), Grafana (`:3000`, admin/admin).

### Register, then call a protected route

```bash
curl -s -X POST http://localhost:8080/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"password123","tier":"pro"}'
# => { "user": {...}, "accessToken": "...", "refreshToken": "...", "expiresIn": 900 }

ACCESS=<accessToken from above>

curl -s http://localhost:8080/api/users/42 -H "Authorization: Bearer $ACCESS"
# proxied straight through to the mock "users" upstream
```

### Refresh (rotates the refresh token)

```bash
curl -s -X POST http://localhost:8080/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH\"}"
# calling /auth/refresh again with the SAME old token now returns
# 401 refresh_token_reused and revokes every session for that user
```

Interactive API docs: **http://localhost:8080/docs** (raw spec at `/docs.json`).

## Rate limiting (the centerpiece)

Per-API-key token bucket via **GCRA** (Generic Cell Rate Algorithm), implemented
as a single atomic Redis Lua script (`gateway/src/rateLimit/gcraScript.ts`) --
one `EVAL` per request does the read-modify-write, so there's no
check-then-set race under concurrency. Verified directly: 500 concurrent
requests at a Redis-enforced burst of 50 let through **exactly** 50, zero
overshoot.

- Keyed by API key when authenticated (the account's tier, embedded as a JWT
  claim, decides the limit); falls back to source IP for public routes.
- Limits are configurable per tier in `gateway/config/routes.yaml`.
- `429` responses carry `Retry-After`; every response carries
  `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`.

```bash
# free tier: burst=10 -- the 11th rapid request gets a 429
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code} " http://localhost:8080/api/users/1 \
    -H "Authorization: Bearer $FREE_TIER_ACCESS_TOKEN"
done
```

**Why GCRA over a sliding-window log or fixed window?** It needs O(1) memory
per client (one Redis key, not a growing set of timestamps), it's a single
round trip, and it naturally allows short bursts while enforcing a steady
sustained rate -- the same approach used by Cloudflare and Kong.

## Rollback / circuit breaker

`/api/orders` is configured with two upstream versions (`v1`, `v2`) and
`rollback.enabled: true`. After every proxied response, the gateway records
success/error into a Redis-backed rolling window per `(route, version)` (same
atomic-Lua-script pattern as the rate limiter, so it's correct even with
multiple gateway instances). Once the error rate crosses
`rollback.errorThreshold` (default 50%, minimum 5 samples), it automatically
flips `activeVersion` back to the other version -- no restart required.

```bash
# force a "bad deploy": flip /api/orders to v2 (seeded with a 60% error rate)
curl -s -X POST http://localhost:8080/admin/routes/version \
  -H "Authorization: Bearer $ACCESS" -H "Content-Type: application/json" \
  -d '{"routePath":"/api/orders","version":"v2"}'

# hammer it a few dozen times...
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code} " http://localhost:8080/api/orders/$i \
    -H "Authorization: Bearer $ACCESS"
done

# ...then check status: activeVersion should already be back to v1
curl -s http://localhost:8080/admin/routes -H "Authorization: Bearer $ACCESS"
```

Gateway logs show the trip:
```json
{"level":"warn","route":"/api/orders","from":"v2","to":"v1","errorRate":0.5,"sampleSize":8,"msg":"circuit breaker tripped: rolling back to previous version"}
```

Known simplification: with exactly two versions this always rolls back to
"the other one" and doesn't require consecutive healthy samples before
re-promoting -- fine for this demo (only v2 is seeded with errors), but a real
system would track more history to avoid flapping between two bad versions.

## Monitoring

- `GET /metrics` -- Prometheus text format: request counts and latency
  histograms (by route/method/status), rate-limit rejection counts (by tier),
  upstream error counts (by route/version), plus default Node process metrics.
- Prometheus UI: http://localhost:9090 (Status → Targets should show `gateway`
  as `UP`).
- Grafana: http://localhost:3000 (`admin` / `admin`) -- the "API Gateway"
  dashboard is pre-provisioned with request rate, latency percentiles,
  rate-limit rejections, and upstream error panels.

## Postman

Import `postman/API-Gateway.postman_collection.json` and
`postman/API-Gateway.postman_environment.json`. Run **Auth → Register** once
(its test script captures `accessToken`/`refreshToken`/`apiKey` into
environment variables); every other request reuses them. Covers the full auth
flow, proxied requests, rate-limit header assertions, rollback admin control,
and the monitoring endpoints. Also runnable headlessly:

```bash
npx newman run postman/API-Gateway.postman_collection.json \
  -e postman/API-Gateway.postman_environment.json
```

## How I tested 1000+ req/sec

`loadtest/` is a standalone Go module (goroutine-based, not a gateway
dependency) that fires an aggregate target req/sec across a configurable
number of concurrent workers and reports the **actual achieved** rate plus
p50/p95/p99 latency -- not just the number you asked for.

```bash
cd loadtest
go build -o loadtest .   # or: docker build -t loadtest-cli .

./loadtest \
  -url http://localhost:8080/api/users/1 \
  -rps 1500 -concurrency 250 -duration 15s \
  -token "$ACCESS"        # a "pro" tier token: 2000 rps / 3000 burst
```

Run against the full docker-compose stack (gateway + Redis + mock upstream,
hitting the real JWT-verify → rate-limit → proxy pipeline on every request),
the committed [`loadtest/sample-results.txt`](loadtest/sample-results.txt)
shows:

```
Total requests:     14951
Successful:         14951 (100.0%)
Achieved req/sec:   1470.7
p50: 63.87ms   p95: 172.57ms   p99: 205.49ms
```

100% success, zero rate-limiting, ~1450 req/sec sustained through the entire
gateway pipeline on a single unclustered Node process on a laptop. Repeated
runs land between ~1200-1470 req/sec (see notes in the sample file) -- add
`-json` for machine-readable output to feed into a chart.

**Note on tiers:** the load test targets a `pro`-tier account specifically so
it measures the gateway's own throughput ceiling rather than the rate
limiter correctly rejecting excess traffic. Point it at a `free`-tier token
(burst=10) instead to watch the limiter clamp down hard, which is the other
half of the story.

## Configuration reference

`gateway/config/routes.yaml` is the single source of truth for routing and
rate-limit tiers, hot-reloaded on edit (no restart needed for tier changes or
manual route edits, though the rollback/admin API's in-memory version
override is reset by the next file-triggered reload).

```yaml
tiers:
  free: { requestsPerSecond: 5, burst: 10 }
  pro:  { requestsPerSecond: 2000, burst: 3000 }

routes:
  - path: /api/users          # matches this path and any /api/users/*
    upstream: http://mock-users:4001
    auth: required            # none | required
    tier: free                # default tier for unauthenticated/public routes

  - path: /api/orders
    auth: required
    tier: pro
    versions: { v1: http://mock-orders-v1:4002, v2: http://mock-orders-v2:4003 }
    activeVersion: v1
    rollback:
      enabled: true
      errorThreshold: 0.5     # fraction of errors in the window that trips it
      windowSize: 50          # rolling count of most recent requests considered
```

Gateway environment variables (see `docker-compose.yml`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Gateway listen port |
| `ROUTES_CONFIG_PATH` | `./config/routes.yaml` | Path to routing config |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | dev defaults | **Change these in any real deployment** |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access token lifetime |
| `REFRESH_TOKEN_TTL_SECONDS` | `604800` | Refresh token lifetime |
| `LOG_LEVEL` | `info` | pino log level |

## Running the gateway without Docker

```bash
cd gateway && npm install
# start Redis and the mock upstreams separately, then:
REDIS_URL=redis://localhost:6379 \
ROUTES_CONFIG_PATH=./config/routes.local.yaml \
JWT_ACCESS_SECRET=dev JWT_REFRESH_SECRET=dev \
npm run dev
```

## Tests

```bash
cd gateway && npm test
```

24 Jest tests covering the rate limiter (burst enforcement, refill timing,
per-key isolation, tier differences), JWT auth middleware (401/403 paths,
claim extraction), token rotation/reuse detection, and the circuit breaker's
threshold/minimum-sample/stale-version logic.

## Deployment

**Live free-tier demo:** [`render.yaml`](render.yaml) is a Render Blueprint that
deploys the gateway + 3 mock upstreams + Redis, entirely on Render's free
plan (no card required, nothing billable). To deploy your own copy: fork this
repo, then in the Render Dashboard choose **New > Blueprint** and point it at
your fork. Render provisions everything the file declares -- JWT secrets are
auto-generated, Redis and the mock upstreams are wired up via internal
hostnames, nothing is hardcoded. Free-tier services spin down after 15
minutes idle and cold-start (a few seconds) on the next request.

**Persistent/paid deployment:** see [DEPLOY.md](DEPLOY.md) for step-by-step
AWS EC2 instructions (security groups, Docker install, TLS, systemd restart
policy).
