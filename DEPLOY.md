# Deploying to AWS EC2

Step-by-step instructions for running this stack on a single EC2 instance.
Nothing here is provisioned automatically -- follow these steps by hand (or
adapt them into your own Terraform/CDK if you have it).

## 1. Launch the instance

- AMI: Ubuntu 22.04 LTS (or Amazon Linux 2023 -- adjust package manager
  commands below accordingly)
- Instance type: `t3.small` is enough for the gateway + Redis + 3 mock
  upstreams + Prometheus + Grafana at demo load. Size up if you're pointing
  the Go load-test tool at it for a serious throughput run.
- Storage: default 20GB gp3 is plenty.
- Key pair: create/attach one you control for SSH.

## 2. Security group

| Type | Port | Source | Why |
|---|---|---|---|
| SSH | 22 | Your IP only (`x.x.x.x/32`) | Admin access. Never `0.0.0.0/0`. |
| HTTP | 80 | `0.0.0.0/0` | Public gateway traffic |
| HTTPS | 443 | `0.0.0.0/0` | Public gateway traffic (TLS) |

Do **not** open 6379 (Redis), 9090 (Prometheus), or 3000 (Grafana) to the
public internet. Reach those via an SSH tunnel instead:

```bash
ssh -L 9090:localhost:9090 -L 3000:localhost:3000 ubuntu@<ec2-public-ip>
# now http://localhost:9090 and http://localhost:3000 on your machine
# proxy through to the instance
```

## 3. Install Docker

SSH in, then:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# run docker without sudo
sudo usermod -aG docker $USER
newgrp docker

docker --version
docker compose version
```

## 4. Get the code onto the instance

```bash
git clone <your-fork-url> api-gateway
cd api-gateway
```

## 5. Set real secrets

```bash
cat > .env << 'EOF'
JWT_ACCESS_SECRET=<generate with: openssl rand -hex 32>
JWT_REFRESH_SECRET=<generate a DIFFERENT one the same way>
EOF
```

`docker-compose.yml` already reads `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`
from the environment (falling back to insecure dev defaults if unset) -- with
`.env` present, `docker compose` picks these up automatically. **Never reuse
the dev-default secrets from the repo in a real deployment.**

## 6. Put the gateway on port 80/443

The gateway container listens on 8080 internally. For a quick demo, the
simplest option is to remap the port directly in `docker-compose.yml`:

```yaml
  gateway:
    ports:
      - "80:8080"
```

For real TLS on 443, put a lightweight reverse proxy in front rather than
teaching the gateway itself about certificates. The two easiest options:

**Option A -- Caddy (simplest, automatic Let's Encrypt certs).** Add to
`docker-compose.yml`:

```yaml
  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    depends_on:
      - gateway

volumes:
  caddy_data:
```

`Caddyfile`:
```
your-domain.com {
    reverse_proxy gateway:8080
}
```

Point your domain's DNS A record at the instance's public IP first --
Caddy needs that to complete the ACME challenge and issue a cert.

**Option B -- AWS Application Load Balancer with an ACM certificate**,
terminating TLS at the ALB and forwarding plain HTTP to the instance's port 80
(or directly to 8080 via a target group). More setup, but offloads cert
renewal to AWS and gives you health checks / multi-instance scaling for free
later. If you go this route, keep the EC2 security group's HTTP/HTTPS rules
scoped to the ALB's security group instead of `0.0.0.0/0`.

## 7. Bring the stack up with a restart policy

`docker-compose.yml`'s services should run with `restart: unless-stopped` so
they survive reboots and crashes. Add it to each service if not already
present, then:

```bash
docker compose up -d --build
docker compose ps
```

To make sure the whole stack comes back after an instance reboot, enable the
Docker daemon itself (it manages restarting containers with a restart policy):

```bash
sudo systemctl enable docker
```

If you'd rather manage it via systemd directly instead of relying on Docker's
own restart policy, add a unit:

```ini
# /etc/systemd/system/api-gateway.service
[Unit]
Description=API Gateway stack
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=/home/ubuntu/api-gateway
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now api-gateway
```

## 8. Verify

```bash
curl https://your-domain.com/health
curl -X POST https://your-domain.com/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"password123"}'
```

From your own machine (not the instance), point the Go load-test tool at the
public URL to confirm throughput end to end:

```bash
cd loadtest
./loadtest -url https://your-domain.com/api/users/1 -rps 500 -concurrency 100 -duration 10s -token "$ACCESS"
```

## Updating a running deployment

```bash
cd api-gateway
git pull
docker compose up -d --build
```

This rebuilds and restarts only what changed; Redis data (users, rate-limit
state) is ephemeral by design in this setup and resets on Redis container
recreation -- if you need durable user data across deploys, mount a volume for
Redis or move user storage to a real database (see README's note on that
tradeoff).

## Rollback

If a deploy goes bad, roll back the code and rebuild:

```bash
git checkout <previous-good-commit-or-tag>
docker compose up -d --build
```

For the application-level rollback (bad upstream *version*, not a bad gateway
deploy), you don't need to touch the instance at all -- that's what the
circuit breaker and `POST /admin/routes/version` are for (see README).
