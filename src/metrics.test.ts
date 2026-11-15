import { beforeEach, describe, expect, test } from "bun:test";
import {
  CounterRegistry,
  counters,
  formatAmplification,
  formatStageReport,
  humanBytes,
  humanMs,
  type ResourceProbe,
  StageRecorder,
  type StageReport,
} from "./metrics";

/** A probe driven entirely by the test, so no real clock is involved. */
function fakeProbe(): ResourceProbe & {
  advance(ms: number): void;
  burnCpu(ms: number): void;
  setRss(bytes: number): void;
} {
  let nowMs = 1000;
  let cpuUs = 0;
  let rss = 100 * 1024 * 1024;
  return {
    now: () => nowMs,
    cpuMicros: () => cpuUs,
    rssBytes: () => rss,
    advance(ms) {
      nowMs += ms;
    },
    burnCpu(ms) {
      cpuUs += ms * 1000;
    },
    setRss(bytes) {
      rss = bytes;
    },
  };
}

describe("CounterRegistry", () => {
  test("counts from absent, defaulting to one", () => {
    const reg = new CounterRegistry();
    reg.inc("a.b");
    reg.inc("a.b");
    reg.inc("a.c", 5);

    expect(reg.get("a.b")).toBe(2);
    expect(reg.get("a.c")).toBe(5);
    expect(reg.get("never.touched")).toBe(0);
    expect(reg.snapshot()).toEqual({ "a.b": 2, "a.c": 5 });
  });

  test("reset clears every counter", () => {
    const reg = new CounterRegistry();
    reg.inc("a");
    reg.reset();
    expect(reg.snapshot()).toEqual({});
  });

  test("delta reports only what moved", () => {
    const before = { kept: 3, moved: 1 };
    const after = { kept: 3, moved: 4, fresh: 2 };

    expect(CounterRegistry.delta(before, after)).toEqual({ moved: 3, fresh: 2 });
  });

  test("delta treats a counter absent from the baseline as starting at zero", () => {
    expect(CounterRegistry.delta({}, { only: 7 })).toEqual({ only: 7 });
  });

  test("the shared registry is a CounterRegistry", () => {
    expect(counters).toBeInstanceOf(CounterRegistry);
  });
});

describe("StageRecorder", () => {
  let registry: CounterRegistry;

  beforeEach(() => {
    registry = new CounterRegistry();
  });

  test("reports wall time, CPU share and counter deltas", () => {
    const probe = fakeProbe();
    registry.inc("proxy.served_bytes", 100); // before the stage, so excluded
    const rec = new StageRecorder("uploading", probe, 250, registry);

    registry.inc("proxy.served_bytes", 1_048_576);
    registry.inc("rd.calls", 4);
    probe.advance(2000);
    probe.burnCpu(500);

    const report = rec.finish("ok");
    expect(report.stage).toBe("uploading");
    expect(report.outcome).toBe("ok");
    expect(report.wallMs).toBe(2000);
    expect(report.cpuMs).toBe(500);
    expect(report.cpuPercent).toBe(25);
    expect(report.counters).toEqual({ "proxy.served_bytes": 1_048_576, "rd.calls": 4 });
  });

  test("a zero-length stage reports no CPU share rather than dividing by zero", () => {
    const probe = fakeProbe();
    const report = new StageRecorder("preparing", probe, 250, registry).finish("ok");

    expect(report.wallMs).toBe(0);
    expect(report.cpuPercent).toBe(0);
  });

  test("tracks peak RSS across samples, not just the endpoints", () => {
    const probe = fakeProbe();
    const rec = new StageRecorder("downloading", probe, 250, registry);

    probe.advance(250);
    probe.setRss(900 * 1024 * 1024); // spike mid-stage
    rec.sample();
    probe.advance(250);
    probe.setRss(120 * 1024 * 1024); // and back down before the end
    rec.sample();

    const report = rec.finish("ok");
    expect(report.rssStartBytes).toBe(100 * 1024 * 1024);
    expect(report.rssPeakBytes).toBe(900 * 1024 * 1024);
  });

  test("a final RSS above every sample still counts as the peak", () => {
    const probe = fakeProbe();
    const rec = new StageRecorder("downloading", probe, 250, registry);

    probe.advance(250);
    rec.sample();
    probe.setRss(500 * 1024 * 1024);

    expect(rec.finish("ok").rssPeakBytes).toBe(500 * 1024 * 1024);
  });

  test("measures loop lag as how late each tick was", () => {
    const probe = fakeProbe();
    const rec = new StageRecorder("uploading", probe, 250, registry);

    probe.advance(250); // punctual
    rec.sample();
    probe.advance(1250); // 1000ms late — a blocked loop
    rec.sample();
    probe.advance(450); // 200ms late
    rec.sample();

    const report = rec.finish("ok");
    expect(report.samples).toBe(3);
    expect(report.loopLagMaxMs).toBe(1000);
    expect(report.loopLagMeanMs).toBeCloseTo(400, 5);
  });

  test("never credits negative lag when a tick lands early", () => {
    const probe = fakeProbe();
    const rec = new StageRecorder("uploading", probe, 250, registry);

    probe.advance(10); // far earlier than the nominal period
    rec.sample();

    const report = rec.finish("ok");
    expect(report.loopLagMaxMs).toBe(0);
    expect(report.loopLagMeanMs).toBe(0);
  });

  test("reports zero lag when nothing sampled", () => {
    const report = new StageRecorder("preparing", fakeProbe(), 250, registry).finish("ok");

    expect(report.samples).toBe(0);
    expect(report.loopLagMeanMs).toBe(0);
  });

  test("records a failed outcome", () => {
    expect(
      new StageRecorder("downloading", fakeProbe(), 250, registry).finish("failed").outcome,
    ).toBe("failed");
  });

  test("defaults to the shared registry", () => {
    const before = counters.get("metrics.test_default");
    const rec = new StageRecorder("preparing", fakeProbe(), 250);
    counters.inc("metrics.test_default");

    expect(rec.finish("ok").counters["metrics.test_default"]).toBe(1);
    expect(counters.get("metrics.test_default")).toBe(before + 1);
  });
});

describe("humanBytes", () => {
  test.each([
    [0, "0B"],
    [512, "512B"],
    [1024, "1.0KB"],
    [1536, "1.5KB"],
    [1024 ** 2, "1.0MB"],
    [1024 ** 3, "1.0GB"],
    [1024 ** 4, "1.0TB"],
    // Beyond the largest unit it keeps scaling TB rather than inventing one.
    [1024 ** 5, "1024.0TB"],
  ])("%i -> %s", (bytes, expected) => {
    expect(humanBytes(bytes)).toBe(expected);
  });
});

describe("humanMs", () => {
  test.each([
    [0, "0ms"],
    [999, "999ms"],
    [1000, "1.0s"],
    [59_999, "60.0s"],
    [60_000, "1m00s"],
    [3_723_000, "62m03s"],
  ])("%i -> %s", (ms, expected) => {
    expect(humanMs(ms)).toBe(expected);
  });
});

describe("formatStageReport", () => {
  const base: StageReport = {
    stage: "uploading",
    outcome: "ok",
    wallMs: 10_000,
    cpuMs: 2500,
    cpuPercent: 25,
    rssStartBytes: 100 * 1024 * 1024,
    rssPeakBytes: 400 * 1024 * 1024,
    loopLagMaxMs: 18,
    loopLagMeanMs: 2,
    samples: 40,
    counters: {},
  };

  test("puts the header, resources, grouped counters and rates on their own lines", () => {
    const text = formatStageReport("job1", {
      ...base,
      counters: {
        "proxy.served_bytes": 10 * 1024 * 1024,
        "proxy.requests": 10,
        "proxy.upstream_bytes": 20 * 1024 * 1024,
        "rd.calls": 20,
        "rd.retries": 5,
      },
    });
    const lines = text.split("\n");

    expect(lines[0]).toBe("[stage] job=job1 stage=uploading ok");
    expect(lines[1]).toContain("wall=10.0s cpu=2.5s (25%)");
    expect(lines[1]).toContain("rss=100.0MB->400.0MB");
    expect(lines[1]).toContain("loop_lag=18ms max/2ms mean over 40 samples");
    // One line per subsystem, counters sorted within it.
    expect(lines[2]).toBe(
      "  proxy.requests=10 proxy.served_bytes=10.0MB proxy.upstream_bytes=20.0MB",
    );
    expect(lines[3]).toBe("  rd.calls=20 rd.retries=5");
    expect(lines[4]).toBe("  serve_rate=1.0MB/s upstream_rate=2.0MB/s rd_retry_rate=25%");
  });

  test("renders byte counters as bytes and everything else as a plain count", () => {
    const text = formatStageReport("job1", {
      ...base,
      counters: { "proxy.disk_bytes": 2048, "proxy.requests": 2048 },
    });

    expect(text).toContain("proxy.requests=2048");
    expect(text).toContain("proxy.disk_bytes=2.0KB");
  });

  test("groups a counter with no dot under misc", () => {
    const text = formatStageReport("job1", { ...base, counters: { lonely: 1 } });

    expect(text).toContain("  lonely=1");
  });

  test("omits the rates line when nothing derivable moved", () => {
    const text = formatStageReport("job1", { ...base, counters: { "proxy.requests": 1 } });

    expect(text.split("\n")).toHaveLength(3);
    expect(text).not.toContain("serve_rate");
  });

  test("reports upstream rate without amplification when nothing was served", () => {
    const text = formatStageReport("job1", {
      ...base,
      counters: { "proxy.upstream_bytes": 20 * 1024 * 1024 },
    });

    expect(text).toContain("upstream_rate=2.0MB/s");
    expect(text).not.toContain("amplification");
  });

  test("omits the RD retry rate when no call was retried", () => {
    const text = formatStageReport("job1", { ...base, counters: { "rd.calls": 20 } });

    expect(text).not.toContain("rd_retry_rate");
  });

  test("skips rates entirely for a zero-length stage", () => {
    const text = formatStageReport("job1", {
      ...base,
      wallMs: 0,
      counters: { "proxy.served_bytes": 1024 },
    });

    expect(text).not.toContain("serve_rate");
  });

  test("reports a failed stage in the header", () => {
    expect(formatStageReport("job1", { ...base, outcome: "failed" })).toContain(
      "stage=uploading failed",
    );
  });

  test("carries no amplification, which is a per-job figure rather than a counter", () => {
    const text = formatStageReport("job1", {
      ...base,
      counters: {
        "proxy.served_bytes": 10 * 1024 * 1024,
        "proxy.upstream_bytes": 10 * 1024 * 1024,
      },
    });

    expect(text).not.toContain("amplification");
  });
});

describe("formatAmplification", () => {
  test("divides bytes served by the payload size", () => {
    expect(
      formatAmplification("job1", {
        requests: 240,
        servedBytes: 15 * 1024 ** 3,
        payloadBytes: 6 * 1024 ** 3,
      }),
    ).toBe("[serve] job=job1 requests=240 served=15.0GB payload=6.0GB amplification=2.50x");
  });

  test("reports zero rather than dividing by an unknown payload", () => {
    expect(formatAmplification("job1", { requests: 0, servedBytes: 0, payloadBytes: 0 })).toContain(
      "amplification=0.00x",
    );
  });
});
