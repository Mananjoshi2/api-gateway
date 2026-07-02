/**
 * GCRA (Generic Cell Rate Algorithm) rate limiter, implemented as a single Lua
 * script so the check-and-update is one atomic round trip to Redis -- no
 * separate GET then SET, so no race window between concurrent requests for the
 * same key. This is what makes it safe under real concurrency (1000+ req/sec,
 * possibly from multiple gateway instances sharing one Redis).
 *
 * GCRA models a token bucket without storing a token count: it stores a single
 * timestamp per key, the "theoretical arrival time" (TAT) -- the point in time
 * at which the bucket would next be completely full if requests kept arriving
 * at exactly the allowed steady rate. Each request nudges TAT forward by one
 * "emission interval"; if doing so would push TAT further than the burst
 * allowance beyond `now`, the request is rejected without being recorded.
 *
 * KEYS[1] = bucket key (e.g. "ratelimit:{tier}:{apiKeyOrIp}")
 * ARGV[1] = burst          (max requests allowed instantaneously)
 * ARGV[2] = ratePerPeriod  (sustained requests allowed per ARGV[3] ms)
 * ARGV[3] = periodMs       (window length the rate is defined over, e.g. 1000)
 * ARGV[4] = nowMs          (caller-supplied current time, epoch ms)
 * ARGV[5] = cost           (tokens this request consumes; normally 1)
 *
 * Returns: { allowed(1/0), remaining, resetAfterMs, retryAfterMs }
 */
export const GCRA_SCRIPT = `
local key = KEYS[1]
local burst = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local period_ms = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])

local emission_interval = period_ms / rate
local burst_offset = emission_interval * burst

local tat = tonumber(redis.call('GET', key))
if tat == nil then
  tat = now
end
tat = math.max(tat, now)

local new_tat = tat + (emission_interval * cost)
local allow_at = new_tat - burst_offset
local diff = now - allow_at
local remaining = math.floor(diff / emission_interval)

if remaining < 0 then
  local retry_after = -diff
  local reset_after = tat - now
  return { 0, 0, math.ceil(reset_after), math.ceil(retry_after) }
end

local reset_after = new_tat - now
if reset_after > 0 then
  redis.call('SET', key, new_tat, 'PX', math.ceil(reset_after))
end

return { 1, remaining, math.ceil(reset_after), 0 }
`;
