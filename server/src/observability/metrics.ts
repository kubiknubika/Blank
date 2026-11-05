/**
 * Dependency-free Prometheus metrics. A registry with counters, one
 * request-duration histogram and gauge collectors, rendered in the
 * Prometheus text exposition format (v0.0.4).
 *
 * Cardinality rule: the `route` label is the matched route PATTERN
 * ("/api/applications/:id"), never the raw URL — otherwise every id
 * would create a new time series and melt the scraper.
 */

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelsToString(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

interface Histogram {
  buckets: number[]; // cumulative counts, parallel to DURATION_BUCKETS
  sum: number;
  count: number;
}

export class MetricsRegistry {
  private counters = new Map<string, { labels: Record<string, string>; value: number }>();
  private histograms = new Map<string, { labels: Record<string, string>; data: Histogram }>();
  private collectors: (() => string)[] = [];

  constructor(private now: () => number = Date.now) {
    const startedAt = this.now();
    this.collectors.push(() => {
      const uptime = (this.now() - startedAt) / 1000;
      const rss = process.memoryUsage().rss;
      return [
        '# HELP process_uptime_seconds Process uptime in seconds.',
        '# TYPE process_uptime_seconds gauge',
        `process_uptime_seconds ${uptime}`,
        '# HELP process_resident_memory_bytes Resident memory size in bytes.',
        '# TYPE process_resident_memory_bytes gauge',
        `process_resident_memory_bytes ${rss}`,
      ].join('\n');
    });
  }

  /** Extra gauge lines computed at scrape time (e.g. row counts). */
  addCollector(collector: () => string): void {
    this.collectors.push(collector);
  }

  incRequest(method: string, route: string, status: number): void {
    const labels = { method, route, status: String(status) };
    const key = `${method}|${route}|${status}`;
    const entry = this.counters.get(key);
    if (entry) entry.value += 1;
    else this.counters.set(key, { labels, value: 1 });
  }

  observeDuration(method: string, route: string, seconds: number): void {
    const labels = { method, route };
    const key = `${method}|${route}`;
    let entry = this.histograms.get(key);
    if (!entry) {
      entry = { labels, data: { buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 } };
      this.histograms.set(key, entry);
    }
    entry.data.sum += seconds;
    entry.data.count += 1;
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      if (seconds <= DURATION_BUCKETS[i]) entry.data.buckets[i] += 1;
    }
  }

  render(): string {
    const lines: string[] = [];

    lines.push('# HELP http_requests_total Total HTTP requests by method, route and status.');
    lines.push('# TYPE http_requests_total counter');
    for (const { labels, value } of this.counters.values()) {
      lines.push(`http_requests_total${labelsToString(labels)} ${value}`);
    }

    lines.push('# HELP http_request_duration_seconds HTTP request latency by method and route.');
    lines.push('# TYPE http_request_duration_seconds histogram');
    for (const { labels, data } of this.histograms.values()) {
      for (let i = 0; i < DURATION_BUCKETS.length; i++) {
        const l = labelsToString({ ...labels, le: String(DURATION_BUCKETS[i]) });
        lines.push(`http_request_duration_seconds_bucket${l} ${data.buckets[i]}`);
      }
      lines.push(
        `http_request_duration_seconds_bucket${labelsToString({ ...labels, le: '+Inf' })} ${data.count}`,
      );
      lines.push(`http_request_duration_seconds_sum${labelsToString(labels)} ${data.sum}`);
      lines.push(`http_request_duration_seconds_count${labelsToString(labels)} ${data.count}`);
    }

    for (const collector of this.collectors) lines.push(collector());
    return lines.join('\n') + '\n';
  }
}
