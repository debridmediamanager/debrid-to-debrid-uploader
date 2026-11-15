import { describe, expect, test } from "bun:test";
import { claimsSponsor, jobLimitFor } from "./owners";

const owners = { tbUserId: "tb:1", rdUserId: "rd:2", adUserId: "", pmUserId: "pm:3" };
const limits = { normal: 1, sponsor: 3 };
const none = new Set<string>();

describe("claimsSponsor", () => {
  test("accepts the spellings a JSON, form or query caller sends", () => {
    expect(claimsSponsor(true)).toBe(true);
    expect(claimsSponsor("true")).toBe(true);
    expect(claimsSponsor("1")).toBe(true);
  });

  test("treats everything else as a non-sponsor", () => {
    // Defaults closed: an unexpected shape must never read as a sponsorship.
    for (const value of [undefined, null, false, "", "0", "false", "yes", 1, {}, []]) {
      expect(claimsSponsor(value)).toBe(false);
    }
  });
});

describe("jobLimitFor", () => {
  test("a non-sponsor gets the normal ceiling", () => {
    expect(jobLimitFor(owners, false, limits, none)).toBe(1);
  });

  test("a sponsor gets the raised ceiling", () => {
    expect(jobLimitFor(owners, true, limits, none)).toBe(3);
  });

  test("a sponsor is never demoted by a deployment that raised the normal limit", () => {
    expect(jobLimitFor(owners, true, { normal: 8, sponsor: 3 }, none)).toBe(8);
  });

  test("the operator exemption still means no limit at all", () => {
    expect(jobLimitFor(owners, false, limits, new Set(["rd:2"]))).toBeNull();
    expect(jobLimitFor(owners, true, limits, new Set(["rd:2"]))).toBeNull();
  });

  test("sponsorship raises the ceiling, it does not remove it", () => {
    // The distinction the whole design rests on: every in-flight job holds a
    // TorBox slot, and the shared account has five. A sponsor tier that
    // returned null here would spend slots this host does not have.
    expect(jobLimitFor(owners, true, limits, none)).not.toBeNull();
  });

  test("exemption is matched on any provider account on the job", () => {
    // Delegated to isUnlimitedOwner, which asks the different question "is this
    // the operator" across every provider — Premiumize included, which nothing
    // counts against.
    expect(jobLimitFor(owners, false, limits, new Set(["tb:1"]))).toBeNull();
    expect(jobLimitFor(owners, false, limits, new Set(["pm:3"]))).toBeNull();
    expect(jobLimitFor(owners, false, limits, new Set(["rd:999"]))).toBe(1);
  });
});
