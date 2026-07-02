// Command loadtest is a standalone concurrent HTTP load generator used to
// exercise the gateway's rate limiter and reverse proxy under real
// concurrency, and to produce the numbers behind the "handles 1000+ req/sec"
// claim in the top-level README.
//
// It is intentionally not a dependency of the gateway service -- it's a
// separate Go module you build and run against a running gateway instance.
package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"
)

// Summary is the machine-readable result of a run (also what -json prints).
type Summary struct {
	TargetURL     string  `json:"targetUrl"`
	Method        string  `json:"method"`
	TargetRPS     int     `json:"targetRps"`
	Concurrency   int     `json:"concurrency"`
	DurationSec   float64 `json:"durationSeconds"`
	TotalRequests int64   `json:"totalRequests"`
	Successful    int64   `json:"successful"`
	Failed        int64   `json:"failed"`
	RateLimited   int64   `json:"rateLimited"`
	AchievedRPS   float64 `json:"achievedRps"`
	MinMs         float64 `json:"minMs"`
	AvgMs         float64 `json:"avgMs"`
	MaxMs         float64 `json:"maxMs"`
	P50Ms         float64 `json:"p50Ms"`
	P95Ms         float64 `json:"p95Ms"`
	P99Ms         float64 `json:"p99Ms"`
}

type workerResult struct {
	latencies   []time.Duration
	success     int64
	failed      int64
	rateLimited int64
}

func main() {
	url := flag.String("url", "", "Target URL to load test (required)")
	rps := flag.Int("rps", 100, "Target aggregate requests per second, split across all workers")
	duration := flag.Duration("duration", 10*time.Second, "How long to run the test, e.g. 10s, 1m")
	concurrency := flag.Int("concurrency", 50, "Number of concurrent worker goroutines")
	token := flag.String("token", "", "Optional JWT bearer token sent as Authorization: Bearer <token>")
	method := flag.String("method", "GET", "HTTP method to use")
	timeout := flag.Duration("timeout", 5*time.Second, "Per-request timeout")
	jsonOutput := flag.Bool("json", false, "Print a machine-readable JSON summary instead of the human-readable report")
	flag.Parse()

	if *url == "" {
		fmt.Fprintln(os.Stderr, "Error: -url is required")
		flag.Usage()
		os.Exit(1)
	}
	if *rps <= 0 || *concurrency <= 0 {
		fmt.Fprintln(os.Stderr, "Error: -rps and -concurrency must both be positive")
		os.Exit(1)
	}

	if !*jsonOutput {
		fmt.Printf("Load testing %s\n", *url)
		fmt.Printf("  target: %d req/sec | concurrency: %d | duration: %s\n\n", *rps, *concurrency, *duration)
	}

	summary := run(*url, *method, *token, *rps, *concurrency, *duration, *timeout)

	if *jsonOutput {
		// Pure JSON on stdout -- no banner, no report -- so this is pipeable
		// straight into a file or a charting script (see -json flag docs).
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(summary); err != nil {
			fmt.Fprintln(os.Stderr, "failed to encode JSON:", err)
			os.Exit(1)
		}
		return
	}

	printReport(summary)
}

func run(url, method, token string, rps, concurrency int, duration, timeout time.Duration) Summary {
	client := &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			MaxIdleConns:        concurrency * 2,
			MaxIdleConnsPerHost: concurrency * 2,
			IdleConnTimeout:     30 * time.Second,
			TLSClientConfig:     &tls.Config{InsecureSkipVerify: true},
		},
	}

	// Each of `concurrency` workers fires at rps/concurrency so the aggregate
	// matches the requested target rate. If a worker's request takes longer
	// than its interval, it moves straight to the next one with no sleep --
	// under real load this naturally shows up as a lower "achieved req/sec"
	// than the target, which is the honest number we want to report.
	perWorkerInterval := time.Duration(float64(time.Second) * float64(concurrency) / float64(rps))

	results := make([]workerResult, concurrency)
	var wg sync.WaitGroup

	start := time.Now()
	deadline := start.Add(duration)

	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			local := workerResult{latencies: make([]time.Duration, 0, rps/concurrency*int(duration.Seconds())+16)}

			for time.Now().Before(deadline) {
				reqStart := time.Now()
				status, err := doRequest(client, method, url, token)
				latency := time.Since(reqStart)
				local.latencies = append(local.latencies, latency)

				switch {
				case err != nil:
					local.failed++
				case status == http.StatusTooManyRequests:
					local.rateLimited++
					local.failed++
				case status >= 200 && status < 400:
					local.success++
				default:
					local.failed++
				}

				if sleepFor := perWorkerInterval - latency; sleepFor > 0 {
					time.Sleep(sleepFor)
				}
			}

			results[idx] = local
		}(i)
	}

	wg.Wait()
	actualDuration := time.Since(start)

	return summarize(url, method, rps, concurrency, actualDuration, results)
}

func doRequest(client *http.Client, method, url, token string) (int, error) {
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		return 0, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

func summarize(url, method string, rps, concurrency int, actualDuration time.Duration, results []workerResult) Summary {
	var latencies []time.Duration
	var success, failed, rateLimited int64
	for _, r := range results {
		latencies = append(latencies, r.latencies...)
		success += r.success
		failed += r.failed
		rateLimited += r.rateLimited
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })

	percentile := func(p float64) time.Duration {
		if len(latencies) == 0 {
			return 0
		}
		idx := int(p * float64(len(latencies)))
		if idx >= len(latencies) {
			idx = len(latencies) - 1
		}
		return latencies[idx]
	}

	var sum time.Duration
	for _, l := range latencies {
		sum += l
	}
	var avg time.Duration
	if len(latencies) > 0 {
		avg = sum / time.Duration(len(latencies))
	}
	var min, max time.Duration
	if len(latencies) > 0 {
		min, max = latencies[0], latencies[len(latencies)-1]
	}

	toMs := func(d time.Duration) float64 { return float64(d.Microseconds()) / 1000.0 }
	total := success + failed

	return Summary{
		TargetURL:     url,
		Method:        method,
		TargetRPS:     rps,
		Concurrency:   concurrency,
		DurationSec:   actualDuration.Seconds(),
		TotalRequests: total,
		Successful:    success,
		Failed:        failed,
		RateLimited:   rateLimited,
		AchievedRPS:   float64(total) / actualDuration.Seconds(),
		MinMs:         toMs(min),
		AvgMs:         toMs(avg),
		MaxMs:         toMs(max),
		P50Ms:         toMs(percentile(0.50)),
		P95Ms:         toMs(percentile(0.95)),
		P99Ms:         toMs(percentile(0.99)),
	}
}

func printReport(s Summary) {
	successRate := 0.0
	if s.TotalRequests > 0 {
		successRate = float64(s.Successful) / float64(s.TotalRequests) * 100
	}

	fmt.Println("Results")
	fmt.Println("=======")
	fmt.Printf("  Total requests:     %d\n", s.TotalRequests)
	fmt.Printf("  Successful:         %d (%.1f%%)\n", s.Successful, successRate)
	fmt.Printf("  Failed:             %d\n", s.Failed)
	fmt.Printf("  Rate limited (429): %d\n", s.RateLimited)
	fmt.Printf("  Actual duration:    %.2fs\n", s.DurationSec)
	fmt.Printf("  Achieved req/sec:   %.1f\n", s.AchievedRPS)
	fmt.Println()
	fmt.Println("Latency")
	fmt.Println("=======")
	fmt.Printf("  min: %.2fms   avg: %.2fms   max: %.2fms\n", s.MinMs, s.AvgMs, s.MaxMs)
	fmt.Printf("  p50: %.2fms   p95: %.2fms   p99: %.2fms\n", s.P50Ms, s.P95Ms, s.P99Ms)
}
