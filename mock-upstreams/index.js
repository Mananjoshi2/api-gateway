'use strict';

const express = require('express');

// A single tiny service, parameterized by env vars so docker-compose can spin up
// several "different" upstreams (users, orders-v1, orders-v2) from one image.
const SERVICE_NAME = process.env.SERVICE_NAME || 'mock-upstream';
const PORT = process.env.PORT || 4000;
const ERROR_RATE = parseFloat(process.env.ERROR_RATE || '0'); // 0..1, fraction of requests that 500
const MIN_LATENCY_MS = parseInt(process.env.MIN_LATENCY_MS || '0', 10);
const MAX_LATENCY_MS = parseInt(process.env.MAX_LATENCY_MS || '0', 10);

const app = express();
app.use(express.json());

function randomLatency() {
  if (MAX_LATENCY_MS <= MIN_LATENCY_MS) return 0;
  return MIN_LATENCY_MS + Math.floor(Math.random() * (MAX_LATENCY_MS - MIN_LATENCY_MS));
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME });
});

// Catch-all: simulate a real backend resource. Echoes the request id injected by
// the gateway so requests can be traced gateway -> upstream in the logs.
app.use((req, res) => {
  const delay = randomLatency();

  setTimeout(() => {
    if (ERROR_RATE > 0 && Math.random() < ERROR_RATE) {
      return res.status(500).json({
        error: 'simulated_upstream_error',
        service: SERVICE_NAME,
        requestId: req.headers['x-request-id'] || null,
      });
    }

    res.status(200).json({
      service: SERVICE_NAME,
      method: req.method,
      path: req.originalUrl,
      requestId: req.headers['x-request-id'] || null,
      receivedAt: new Date().toISOString(),
      body: req.body && Object.keys(req.body).length ? req.body : undefined,
    });
  }, delay);
});

app.listen(PORT, () => {
  console.log(JSON.stringify({ msg: 'mock upstream listening', service: SERVICE_NAME, port: PORT, errorRate: ERROR_RATE }));
});
