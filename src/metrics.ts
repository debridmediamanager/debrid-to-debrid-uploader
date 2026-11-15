/**
 * Per-stage iteration counts and resource usage.
 *
 * Two pieces. `counters` is a flat process-wide tally that the seams bump as
 * they work — one `inc` per RD call, per retry, per proxy request, per byte
 * pulled from an upstream. `StageRecorder` snapshots it around a stage and
 * reports the delta, alongside wall time, CPU time, peak RSS and event-loop lag.
 *
 * Process-wide rather than per-job on purpose: the counters live inside
 * `realdebrid.ts`, `torbox.ts` and `proxy.ts`, none of which know a job id, and
 * threading one through every seam would be a lot of plumbing for a service
 * that runs one job at a time. The cost is that two concurrent jobs blend their
 * counts into both reports. Wall time, CPU and RSS are process-wide regardless,
 * since there is one event loop.
 *
 * The counter that earns this module its keep is `proxy.upstream_bytes`. Every
 * byte there is billable TorBox egress, and TorBox bans an account on the
 * fourth bandwidth strike — so the amplification between it and
 * `proxy.served_bytes` is the number to watch.
 *
 * Everything here is injectable and side-effect free so the tests can drive a
 * fake clock. The real `process`/timer wiring lives in `worker.ts`.
 */

export type Counters = Record<string, number>;

/** Cumulative counts, keyed by a dotted `subsystem.event` name. */
export class CounterRegistry {
  private readonly values: Map<string, number>;

  /**
   * Assigned here rather than as a class field initializer. Bun 1.3.14 counts
   * every field initializer as an extra function and never marks it hit, which
   * silently caps the file below the 100% `functions` threshold in
   * `bunfig.toml` no matter how thorough the tests are. Verified in isolation:
   * the identical class with an initializer reports 75% functions at 100% line
   * coverage; with the assignment moved in here, 100%.
   */
  constructor() {
    this.values = new Map();
  }

  inc(name: string, by = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  snapshot(): Counters {
    return Object.fromEntries(this.values);
  }

  /** Counters that moved between two snapshots, zero-deltas dropped. */
  static delta(before: Counters, after: Counters): Counters {
    const out: Counters = {};
    for (const [name, value] of Object.entries(after)) {
      const moved = value - (before[name] ?? 0);
      if (moved !== 0) out[name] = moved;
    }
    return out;
  }

  /** Test seam. Nothing in the pipeline resets counters. */
  reset(): void {
    this.values.clear();
  }
}

/** The single tally every seam bumps. */
export const counters = new CounterRegistry();

/**
 * Wall clock, CPU consumption and resident size. Injected so tests need no real
 * `process`, and so a stage can be replayed deterministically.
 */
export type ResourceProbe = {
  /** Monotonic milliseconds. */
  now(): number;
  /** Cumulative CPU microseconds, user + system. */
  cpuMicros(): number;
  /** Current resident set size in bytes. */
  rssBytes(): number;
};

export type StageReport = {
  stage: string;
  outcome: "ok" | "failed";
  wallMs: number;
  cpuMs: number;
  /** CPU milliseconds per wall millisecond, as a percentage. Can exceed 100 on
   *  a threadpool-backed workload, which is a finding rather than a bug. */
  cpuPercent: number;
  rssStartBytes: number;
  rssPeakBytes: number;
  /** Worst observed delay of the sampling tick beyond its nominal period. Zero
   *  when nothing sampled. This is the metric that exposes a blocked loop — a
   *  synchronous disk read in the proxy shows up here and nowhere else. */
  loopLagMaxMs: number;
  loopLagMeanMs: number;
  samples: number;
  counters: Counters;
};

/**
 * Accumulates one stage's measurements. `sample()` is driven externally — by a
 * timer in `worker.ts` — so the recorder itself stays synchronous and pure.
 */
export class StageRecorder {
  private readonly startedAt: number;
  private readonly cpuAtStart: number;
  private readonly countersAtStart: Counters;
  private readonly rssAtStart: number;
  private rssPeak: number;
  // Zeroed in the constructor rather than as field initializers, for the Bun
  // function-counting reason documented on CounterRegistry.
  private lagMax: number;
  private lagTotal: number;
  private sampleCount: number;
  private lastSampleAt: number;

  constructor(
    readonly stage: string,
    private readonly probe: ResourceProbe,
    /** Nominal gap between `sample()` calls; anything beyond it is loop lag. */
    private readonly sampleIntervalMs: number,
    private readonly registry: CounterRegistry = counters,
  ) {
    this.lagMax = 0;
    this.lagTotal = 0;
    this.sampleCount = 0;
    this.startedAt = probe.now();
    this.lastSampleAt = this.startedAt;
    this.cpuAtStart = probe.cpuMicros();
    this.countersAtStart = registry.snapshot();
    this.rssAtStart = probe.rssBytes();
    this.rssPeak = this.rssAtStart;
  }

  /** One tick. Tracks peak RSS and how late this tick was. */
  sample(): void {
    const at = this.probe.now();
    const late = at - this.lastSampleAt - this.sampleIntervalMs;
    // A tick can only be late, never early; clamp so a coarse clock cannot
    // credit the loop with negative lag.
    const lag = late > 0 ? late : 0;
    this.lastSampleAt = at;
    this.lagMax = Math.max(this.lagMax, lag);
    this.lagTotal += lag;
    this.sampleCount++;

    const rss = this.probe.rssBytes();
    if (rss > this.rssPeak) this.rssPeak = rss;
  }

  finish(outcome: "ok" | "failed"): StageReport {
    const wallMs = this.probe.now() - this.startedAt;
    const cpuMs = (this.probe.cpuMicros() - this.cpuAtStart) / 1000;
    const rss = this.probe.rssBytes();
    if (rss > this.rssPeak) this.rssPeak = rss;

    return {
      stage: this.stage,
      outcome,
      wallMs,
      cpuMs,
      cpuPercent: wallMs > 0 ? (cpuMs / wallMs) * 100 : 0,
      rssStartBytes: this.rssAtStart,
      rssPeakBytes: this.rssPeak,
      loopLagMaxMs: this.lagMax,
      loopLagMeanMs: this.sampleCount > 0 ? this.lagTotal / this.sampleCount : 0,
      samples: this.sampleCount,
      counters: CounterRegistry.delta(this.countersAtStart, this.registry.snapshot()),
    };
  }
}

// ------------------------------------------------------------- formatting

export function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value}B` : `${value.toFixed(1)}${units[unit]}`;
}

export function humanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** Counter names whose values are byte totals, so they print as bytes. */
const BYTE_COUNTERS = /(^|\.)(bytes|.*_bytes)$/;

function formatCounter(name: string, value: number): string {
  return `${name}=${BYTE_COUNTERS.test(name) ? humanBytes(value) : value}`;
}

/**
 * Derived rates worth having pre-computed in the log, since they are what any
 * later comparison actually looks at.
 *
 * There is deliberately no amplification figure here. On the TorBox path the
 * proxy forwards exactly the window it fetched, so `proxy.upstream_bytes` and
 * `proxy.served_bytes` are equal by construction and their ratio would always
 * print 1.00x. The meaningful denominator is the payload size, which is a
 * per-job property rather than a counter — `worker.ts` logs that figure when
 * the job completes.
 */
function derived(report: StageReport): string[] {
  const out: string[] = [];
  const seconds = report.wallMs / 1000;
  if (seconds <= 0) return out;

  const served = report.counters["proxy.served_bytes"] ?? 0;
  if (served > 0) out.push(`serve_rate=${humanBytes(served / seconds)}/s`);

  const upstream = report.counters["proxy.upstream_bytes"] ?? 0;
  if (upstream > 0) out.push(`upstream_rate=${humanBytes(upstream / seconds)}/s`);

  const calls = report.counters["rd.calls"] ?? 0;
  const retries = report.counters["rd.retries"] ?? 0;
  if (calls > 0 && retries > 0) out.push(`rd_retry_rate=${Math.round((retries / calls) * 100)}%`);

  return out;
}

/**
 * Read amplification for one job: bytes handed to RD over the size of the
 * payload it was fetching. 1.0x would mean RD took every byte exactly once;
 * anything above is surplus produced by the range expansion and thrown away,
 * and on the TorBox path it was paid for.
 */
export function formatAmplification(
  jobId: string,
  stats: { requests: number; servedBytes: number; payloadBytes: number },
): string {
  const ratio = stats.payloadBytes > 0 ? stats.servedBytes / stats.payloadBytes : 0;
  return (
    `[serve] job=${jobId} requests=${stats.requests} ` +
    `served=${humanBytes(stats.servedBytes)} payload=${humanBytes(stats.payloadBytes)} ` +
    `amplification=${ratio.toFixed(2)}x`
  );
}

/**
 * A multi-line block per stage: a header, a resource line, the counters grouped
 * by subsystem, then derived rates. Grouping keeps the line lengths sane on a
 * stage that touches a dozen counters.
 */
export function formatStageReport(jobId: string, report: StageReport): string {
  const lines = [`[stage] job=${jobId} stage=${report.stage} ${report.outcome}`];

  lines.push(
    `  wall=${humanMs(report.wallMs)} cpu=${humanMs(report.cpuMs)} ` +
      `(${report.cpuPercent.toFixed(0)}%) rss=${humanBytes(report.rssStartBytes)}` +
      `->${humanBytes(report.rssPeakBytes)} ` +
      `loop_lag=${humanMs(report.loopLagMaxMs)} max/${humanMs(report.loopLagMeanMs)} mean ` +
      `over ${report.samples} samples`,
  );

  const groups = new Map<string, string[]>();
  for (const name of Object.keys(report.counters).sort()) {
    const group = name.includes(".") ? name.slice(0, name.indexOf(".")) : "misc";
    const entries = groups.get(group) ?? [];
    entries.push(formatCounter(name, report.counters[name]));
    groups.set(group, entries);
  }
  for (const [, entries] of groups) lines.push(`  ${entries.join(" ")}`);

  const rates = derived(report);
  if (rates.length > 0) lines.push(`  ${rates.join(" ")}`);

  return lines.join("\n");
}
