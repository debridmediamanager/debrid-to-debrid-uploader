import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissingCredentialError } from "./credentials";
import * as premiumize from "./premiumize";

/** Every call needs its own credential; there is no operator fallback. */
const PM = { apiKey: "PM_KEY" };

const originalFetch = globalThis.fetch;
let tempDirs: string[] = [];

function writeTorrent(name = "rewritten.torrent"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, "d4:infod4:name4:testee");
  return file;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("Premiumize credentials", () => {
  test("every call refuses to run without a key", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: "success" }),
    ) as unknown as typeof fetch;

    await expect(premiumize.getCurrentUser({})).rejects.toThrow(MissingCredentialError);
    await expect(premiumize.getTransfer("t-1", {})).rejects.toThrow(MissingCredentialError);
    await expect(premiumize.checkCached("abc", {})).rejects.toThrow(MissingCredentialError);
    await expect(premiumize.deleteTransfer("t-1", {})).rejects.toThrow(MissingCredentialError);
    await expect(premiumize.createTransferFromFile(writeTorrent(), {})).rejects.toThrow(
      MissingCredentialError,
    );
  });

  test("sends the key as a single capital-B bearer header", async () => {
    const seen: Record<string, string>[] = [];
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return Response.json({ status: "success", customer_id: "704233992" });
    }) as unknown as typeof fetch;

    await premiumize.getCurrentUser(PM);
    expect(seen[0].Authorization).toBe("Bearer PM_KEY");
  });
});

describe("the success envelope, not the HTTP status, is the authority", () => {
  test("a transport failure is reported with its body", async () => {
    globalThis.fetch = mock(
      async () => new Response("gateway down", { status: 502 }),
    ) as unknown as typeof fetch;

    await expect(premiumize.getCurrentUser(PM)).rejects.toThrow(
      "Premiumize account lookup failed: 502 gateway down",
    );
  });

  test("a 200 carrying status=error is a failure, not a success", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: "error", message: "not_logged_in" }),
    ) as unknown as typeof fetch;

    await expect(premiumize.getCurrentUser(PM)).rejects.toThrow(
      "Premiumize account lookup rejected: not_logged_in",
    );
  });

  test("a 200 with neither success nor a message still fails", async () => {
    globalThis.fetch = mock(async () => Response.json({})) as unknown as typeof fetch;

    await expect(premiumize.getCurrentUser(PM)).rejects.toThrow("status is not success");
  });
});

describe("getCurrentUser", () => {
  test("returns the customer id as a string", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: "success", customer_id: "704233992" }),
    ) as unknown as typeof fetch;

    expect(await premiumize.getCurrentUser(PM)).toEqual({ id: "704233992" });
  });

  test("coerces a numeric customer id rather than dropping it", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: "success", customer_id: 704233992 }),
    ) as unknown as typeof fetch;

    expect(await premiumize.getCurrentUser(PM)).toEqual({ id: "704233992" });
  });

  test.each([[undefined], [null], [""]])(
    "refuses a success envelope carrying no usable id (%p)",
    async (customerId) => {
      globalThis.fetch = mock(async () =>
        Response.json({ status: "success", customer_id: customerId }),
      ) as unknown as typeof fetch;

      // Returning undefined here would make every account share one owner
      // string, silently merging unrelated submitters under the per-user limit.
      await expect(premiumize.getCurrentUser(PM)).rejects.toThrow("returned no customer id");
    },
  );
});

describe("createTransferFromFile", () => {
  test("uploads the torrent file itself, not a magnet", async () => {
    let body: FormData | undefined;
    let url = "";
    globalThis.fetch = mock(async (target: string, init: RequestInit) => {
      url = target;
      body = init.body as FormData;
      return Response.json({ status: "success", id: "h-Y6kyaJw83", name: "rewritten.torrent" });
    }) as unknown as typeof fetch;

    expect(await premiumize.createTransferFromFile(writeTorrent(), PM)).toEqual({
      id: "h-Y6kyaJw83",
      name: "rewritten.torrent",
    });
    expect(url).toBe("https://www.premiumize.me/api/transfer/create");
    // A magnet cannot carry `url-list`, so the file upload is the only door in.
    expect(body?.get("file")).toBeInstanceOf(Blob);
    expect(body?.get("src")).toBeNull();
  });

  test("falls back to the file's own name when the response omits one", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: "success", id: "h-abc" }),
    ) as unknown as typeof fetch;

    expect(await premiumize.createTransferFromFile(writeTorrent("job-7.torrent"), PM)).toEqual({
      id: "h-abc",
      name: "job-7.torrent",
    });
  });

  test("refuses a success envelope with no transfer id", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: "success", name: "x.torrent" }),
    ) as unknown as typeof fetch;

    // Without this the monitor would poll an id that was never created for the
    // whole uploading stage before failing as a stall.
    await expect(premiumize.createTransferFromFile(writeTorrent(), PM)).rejects.toThrow(
      "returned no id",
    );
  });
});

describe("getTransfer", () => {
  const transfer = {
    id: "h-abc",
    name: "release",
    status: "running",
    progress: 0.5,
    message: "38.93 MB/s from 0 peer",
    file_id: null,
    folder_id: null,
  };

  test("finds the transfer by id", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: "success", transfers: [{ ...transfer, id: "h-other" }, transfer] }),
    ) as unknown as typeof fetch;

    expect(await premiumize.getTransfer("h-abc", PM)).toEqual(transfer);
  });

  test("answers null when the list no longer carries it", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: "success", transfers: [{ ...transfer, id: "h-other" }] }),
    ) as unknown as typeof fetch;

    // Not an error on its own: `transfer/clearfinished` drops finished rows.
    expect(await premiumize.getTransfer("h-abc", PM)).toBeNull();
  });

  test("treats a missing transfers array as an empty one", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: "success" }),
    ) as unknown as typeof fetch;

    expect(await premiumize.getTransfer("h-abc", PM)).toBeNull();
  });
});

describe("checkCached", () => {
  test("reads the first slot of the response array", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: "success", response: [true] }),
    ) as unknown as typeof fetch;

    expect(await premiumize.checkCached("abc", PM)).toBe(true);
  });

  test("a miss is false, not an error", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: "success", response: [false] }),
    ) as unknown as typeof fetch;

    expect(await premiumize.checkCached("abc", PM)).toBe(false);
  });

  test("a response that is not an array reads as a miss", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: "success" }),
    ) as unknown as typeof fetch;

    expect(await premiumize.checkCached("abc", PM)).toBe(false);
  });

  test("sends the hash as a form-encoded items[] entry", async () => {
    let sent = "";
    let headers: Record<string, string> = {};
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      headers = init.headers as Record<string, string>;
      return Response.json({ status: "success", response: [true] });
    }) as unknown as typeof fetch;

    await premiumize.checkCached("8a83e8e9", PM);
    expect(sent).toBe("items%5B%5D=8a83e8e9");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });
});

describe("deleteTransfer", () => {
  test("posts the id and accepts a success envelope", async () => {
    let sent = "";
    let url = "";
    globalThis.fetch = mock(async (target: string, init: RequestInit) => {
      url = target;
      sent = String(init.body);
      return Response.json({ status: "success" });
    }) as unknown as typeof fetch;

    await premiumize.deleteTransfer("h-abc", PM);
    expect(url).toBe("https://www.premiumize.me/api/transfer/delete");
    expect(sent).toBe("id=h-abc");
  });

  test("surfaces a refusal rather than swallowing it", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ status: "error", message: "transfer not found" }),
    ) as unknown as typeof fetch;

    await expect(premiumize.deleteTransfer("h-abc", PM)).rejects.toThrow("transfer not found");
  });
});
