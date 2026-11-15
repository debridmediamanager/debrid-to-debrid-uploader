import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  _clearOwnerCache,
  isUnlimitedOwner,
  type JobOwners,
  liveLookups,
  type OwnerLookups,
  resolveJobOwners,
} from "./owners";

const originalFetch = globalThis.fetch;

afterEach(() => {
  _clearOwnerCache();
  globalThis.fetch = originalFetch;
});

/** Lookups that record the keys they were asked about. */
function stubLookups(overrides: Partial<OwnerLookups> = {}) {
  const calls: { provider: string; apiKey?: string }[] = [];
  const lookups: OwnerLookups = {
    torboxUser: async (apiKey) => {
      calls.push({ provider: "tb", apiKey });
      return { id: 111 };
    },
    rdUser: async (apiKey) => {
      calls.push({ provider: "rd", apiKey });
      return { id: 222 };
    },
    alldebridUser: async (apiKey) => {
      calls.push({ provider: "ad", apiKey });
      return { id: "someuser" };
    },
    premiumizeUser: async (apiKey) => {
      calls.push({ provider: "pm", apiKey });
      return { id: "704233992" };
    },
    ...overrides,
  };
  return { lookups, calls };
}

describe("resolveJobOwners", () => {
  test("resolves every provider on the job to an account id", async () => {
    const { lookups } = stubLookups();
    expect(
      await resolveJobOwners({ tbApiKey: "TB", rdApiKey: "RD", adApiKey: "AD" }, lookups),
    ).toEqual({
      tbUserId: "tb:111",
      rdUserId: "rd:222",
      adUserId: "ad:someuser",
      pmUserId: "",
    });
  });

  test("a job with no AllDebrid key gets no AllDebrid owner", async () => {
    const { lookups, calls } = stubLookups();

    const owners = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: "TB" }, lookups);

    expect(owners.adUserId).toBe("");
    expect(calls.filter((c) => c.provider === "ad")).toHaveLength(0);
  });

  test("caches by credential, so a repeat submission makes no new lookup", async () => {
    const { lookups, calls } = stubLookups();
    const a = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: "TB" }, lookups);
    const b = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: "TB" }, lookups);

    expect(a).toEqual(b);
    expect(calls).toHaveLength(2);
  });

  test("a job with no TorBox key gets no TorBox owner", async () => {
    // AllDebrid-only jobs are legitimate, and there is no operator account to
    // resolve to any more — that side of the limit is simply absent, and must
    // not be looked up under somebody else's credential.
    const { lookups, calls } = stubLookups();

    const owners = await resolveJobOwners({ rdApiKey: "RD" }, lookups);

    expect(owners.tbUserId).toBe("");
    expect(owners.rdUserId).toBe("rd:222");
    expect(calls.filter((c) => c.provider === "tb")).toHaveLength(0);
  });

  test("two keys for one account resolve to the same owner", async () => {
    // The reason the limit is keyed on the account and not the credential:
    // TorBox rotates the key on every abuse warning.
    const { lookups } = stubLookups();
    const first = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: "OLD_KEY" }, lookups);
    const second = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: "ROTATED_KEY" }, lookups);

    expect(second.tbUserId).toBe(first.tbUserId);
  });

  test("different accounts stay distinct", async () => {
    const { lookups } = stubLookups({
      torboxUser: async (apiKey) => ({ id: apiKey === "OTHER" ? 999 : 111 }),
    });

    const mine = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: "MINE" }, lookups);
    const theirs = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: "OTHER" }, lookups);

    expect(mine.tbUserId).toBe("tb:111");
    expect(theirs.tbUserId).toBe("tb:999");
  });

  test("a burst on one key makes a single lookup", async () => {
    const { lookups, calls } = stubLookups();

    const resolved = await Promise.all(
      Array.from({ length: 5 }, () =>
        resolveJobOwners({ tbApiKey: "TB", rdApiKey: "RD" }, lookups),
      ),
    );

    expect(calls).toHaveLength(2);
    for (const owners of resolved) expect(owners).toEqual(resolved[0]);
  });

  test("a failed lookup degrades to the key digest rather than disabling the limit", async () => {
    const { lookups } = stubLookups({
      torboxUser: async () => {
        throw new Error("TorBox down");
      },
    });

    const owners = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: "TB" }, lookups);

    // Still an owner, so the limit still applies — just per key rather than per
    // account. Returning nothing would silently exempt whoever is having an
    // outage, which is the wrong direction to fail in.
    expect(owners.tbUserId).toMatch(/^tb:key:[0-9a-f]{12}$/);
    expect(owners.rdUserId).toBe("rd:222");
  });

  test("the same key degrades to the same owner, a different key to a different one", async () => {
    const { lookups } = stubLookups({
      torboxUser: async () => {
        throw new Error("TorBox down");
      },
    });

    const a = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: "KEY_A" }, lookups);
    const b = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: "KEY_A" }, lookups);
    const c = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: "KEY_B" }, lookups);

    expect(b.tbUserId).toBe(a.tbUserId);
    expect(c.tbUserId).not.toBe(a.tbUserId);
  });

  test("a failure is not cached, so the next submission retries the lookup", async () => {
    let attempts = 0;
    const { lookups } = stubLookups({
      torboxUser: async () => {
        attempts++;
        if (attempts === 1) throw new Error("transient");
        return { id: 111 };
      },
    });

    const degraded = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: "TB" }, lookups);
    const recovered = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: "TB" }, lookups);

    expect(degraded.tbUserId).toMatch(/^tb:key:/);
    expect(recovered.tbUserId).toBe("tb:111");
  });

  test("does not leak the API key into the owner string", async () => {
    const { lookups } = stubLookups({
      torboxUser: async () => {
        throw new Error("down");
      },
    });
    const secret = "SUPER_SECRET_TB_KEY";

    const owners = await resolveJobOwners({ rdApiKey: "RD", tbApiKey: secret }, lookups);

    // The owner is written to the job row and served over the API, so the
    // degraded form has to be a digest and not the credential itself.
    expect(owners.tbUserId).not.toContain(secret);
  });
});

// The operator reaches their own service from whichever account is convenient,
// and at MAX_JOBS_PER_USER=1 that means one job at a time on a box they own. The
// exemption is checked against *every* provider on the job, because which side
// carries the operator's account depends on the direction the job runs in.
describe("isUnlimitedOwner", () => {
  const owners = (patch: Partial<JobOwners> = {}): JobOwners => ({
    tbUserId: "tb:111",
    rdUserId: "rd:222",
    adUserId: "ad:someone",
    ...patch,
    pmUserId: "",
  });

  test("nobody is exempt when the list is empty", () => {
    expect(isUnlimitedOwner(owners(), new Set())).toBe(false);
  });

  test("exempts a job whose Real-Debrid account is listed", () => {
    expect(isUnlimitedOwner(owners(), new Set(["rd:222"]))).toBe(true);
  });

  test("exempts a job whose TorBox account is listed", () => {
    // A TorBox-destination job may carry no RD key at all, so the counted side
    // is not always the side the operator's account sits on.
    expect(isUnlimitedOwner(owners({ rdUserId: "" }), new Set(["tb:111"]))).toBe(true);
  });

  test("exempts a job whose AllDebrid account is listed", () => {
    expect(isUnlimitedOwner(owners(), new Set(["ad:someone"]))).toBe(true);
  });

  test("leaves everyone else limited", () => {
    expect(isUnlimitedOwner(owners(), new Set(["rd:999", "tb:999"]))).toBe(false);
  });

  test("an unresolved side never matches an empty entry", () => {
    // `""` is the sentinel for "this job brought no key for that provider". A
    // stray comma in the env would otherwise exempt every job missing a key.
    expect(isUnlimitedOwner(owners({ adUserId: "" }), new Set([""]))).toBe(false);
  });

  test("a degraded owner is not exempt, so an outage revokes rather than grants", () => {
    // `resolve` falls back to a key digest when the provider cannot be asked.
    // That must fail in the same direction the limit does: still enforced.
    expect(isUnlimitedOwner(owners({ rdUserId: "rd:key:abc123abc123" }), new Set(["rd:222"]))).toBe(
      false,
    );
  });
});

describe("liveLookups", () => {
  test("asks TorBox and Real-Debrid for the account behind a key", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      urls.push(String(url));
      return Response.json({ id: 5, username: "u", data: { id: 9 } });
    }) as unknown as typeof fetch;

    // Each reads its own provider's id out of its own response shape: TorBox
    // nests it under `data`, RD returns it at the top level.
    expect((await liveLookups.torboxUser("TB")).id).toBe(9);
    expect((await liveLookups.rdUser("RD")).id).toBe(5);

    expect(urls[0]).toContain("api.torbox.app");
    expect(urls[0]).toContain("/user/me");
    expect(urls[1]).toContain("api.real-debrid.com");
    expect(urls[1]).toContain("/user");
  });

  test("asks AllDebrid for the username behind a key", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      urls.push(String(url));
      return Response.json({ status: "success", data: { user: { username: "someuser" } } });
    }) as unknown as typeof fetch;

    // AllDebrid exposes no numeric id, so the username stands in as the account
    // identity — mapped onto the same `{id}` shape the other two return.
    expect((await liveLookups.alldebridUser("AD")).id).toBe("someuser");

    expect(urls[0]).toContain("api.alldebrid.com");
    expect(urls[0]).toContain("/user");
  });

  test("asks Premiumize for the customer behind a key", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      urls.push(String(url));
      return Response.json({ status: "success", customer_id: "704233992" });
    }) as unknown as typeof fetch;

    // Premiumize's customer id is already a string, so unlike TorBox and RD it
    // needs no mapping on the way out.
    expect((await liveLookups.premiumizeUser("PM")).id).toBe("704233992");

    expect(urls[0]).toContain("premiumize.me");
    expect(urls[0]).toContain("/account/info");
  });
});

describe("Premiumize as a fourth owner", () => {
  test("resolves the customer id when the job brings a Premiumize key", async () => {
    const { lookups, calls } = stubLookups();

    expect(await resolveJobOwners({ pmApiKey: "PM" }, lookups)).toEqual({
      tbUserId: "",
      rdUserId: "",
      adUserId: "",
      pmUserId: "pm:704233992",
    });
    expect(calls).toEqual([{ provider: "pm", apiKey: "PM" }]);
  });

  test("leaves the Premiumize side unresolved when no key is supplied", async () => {
    const { lookups, calls } = stubLookups();

    const owners = await resolveJobOwners({ rdApiKey: "RD" }, lookups);
    expect(owners.pmUserId).toBe("");
    expect(calls.some((call) => call.provider === "pm")).toBe(false);
  });

  test("a failed Premiumize lookup limits by key rather than disabling the limit", async () => {
    const { lookups } = stubLookups({
      premiumizeUser: async () => {
        throw new Error("Premiumize down");
      },
    });

    const owners = await resolveJobOwners({ pmApiKey: "PM" }, lookups);
    // Degraded to per-key, which keeps the limit enforced — the opposite
    // direction from returning nothing and quietly exempting the account.
    expect(owners.pmUserId).toStartWith("pm:key:");
  });

  test("an exempt Premiumize account lifts the limit like any other side", async () => {
    const owners = {
      tbUserId: "",
      rdUserId: "rd:1",
      adUserId: "",
      pmUserId: "pm:704233992",
    };
    expect(isUnlimitedOwner(owners, new Set(["pm:704233992"]))).toBe(true);
    expect(isUnlimitedOwner(owners, new Set(["pm:999"]))).toBe(false);
  });
});
