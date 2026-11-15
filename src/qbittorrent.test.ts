import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QbitClient } from "./qbittorrent";

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, opts?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = mock(handler as unknown as typeof fetch) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function loginResponse() {
  return new Response("Ok.", {
    headers: { "set-cookie": "SID=abc123; path=/" },
  });
}

describe("QbitClient", () => {
  test("login and addMagnet", async () => {
    const calls: string[] = [];
    const client = new QbitClient();

    mockFetch((url, _opts) => {
      calls.push(url);
      if (url.includes("auth/login")) return loginResponse();
      if (url.includes("torrents/add")) return new Response("Ok.");
      return new Response("not found", { status: 404 });
    });

    await client.addMagnet("magnet:?xt=urn:btih:abc123", "/tmp/save");

    expect(calls).toContain("http://localhost:8080/api/v2/auth/login");
    expect(calls).toContain("http://localhost:8080/api/v2/torrents/add");
  });

  test("addMagnet throws on failure", async () => {
    const client = new QbitClient();

    mockFetch((url) => {
      if (url.includes("auth/login")) return loginResponse();
      return new Response("error", { status: 500 });
    });

    expect(client.addMagnet("magnet:?xt=urn:btih:abc123", "/tmp")).rejects.toThrow(
      "qBit add failed: 500",
    );
  });

  test("addMagnetForMetadata starts the torrent and skips checking", async () => {
    let body = "";
    const client = new QbitClient();
    mockFetch((url, opts) => {
      if (url.includes("auth/login")) return loginResponse();
      body = String(opts?.body ?? "");
      return new Response("Ok.");
    });

    await client.addMagnetForMetadata("magnet:?xt=urn:btih:abc123");

    // Started, not stopped: a stopped torrent connects to nobody and sits in
    // `stoppedDL` forever without ever learning its own metadata.
    expect(body).toContain("stopped=false");
    expect(body).toContain("skip_checking=true");
    // No save path — this add exists to learn the info dict, not to store bytes.
    expect(body).not.toContain("savepath");
  });

  test("addMagnetForMetadata throws on failure", async () => {
    const client = new QbitClient();
    mockFetch((url) => {
      if (url.includes("auth/login")) return loginResponse();
      return new Response("nope", { status: 409 });
    });

    expect(client.addMagnetForMetadata("magnet:")).rejects.toThrow("qBit metadata add failed: 409");
  });

  test("exportTorrent returns the raw torrent bytes", async () => {
    const client = new QbitClient();
    const bytes = Buffer.from("d4:infod4:name3:abcee");
    let asked = "";
    mockFetch((url) => {
      if (url.includes("auth/login")) return loginResponse();
      asked = url;
      return new Response(bytes);
    });

    const out = await client.exportTorrent("abc123");

    expect(asked).toContain("torrents/export?hash=abc123");
    expect(out.equals(bytes)).toBe(true);
  });

  test("exportTorrent throws on failure", async () => {
    const client = new QbitClient();
    mockFetch((url) => {
      if (url.includes("auth/login")) return loginResponse();
      return new Response("gone", { status: 404 });
    });

    expect(client.exportTorrent("abc123")).rejects.toThrow("qBit export failed: 404");
  });

  test("getTorrents", async () => {
    const client = new QbitClient();
    const data = [{ progress: 0.5, dlspeed: 1000, num_seeds: 3, state: "downloading" }];

    mockFetch((url) => {
      if (url.includes("auth/login")) return loginResponse();
      return new Response(JSON.stringify(data));
    });

    const result = await client.getTorrents("abc123");
    expect(result).toEqual(data);
  });

  test("getFiles", async () => {
    const client = new QbitClient();
    const data = [{ name: "movie.mkv", size: 1000 }];

    mockFetch((url) => {
      if (url.includes("auth/login")) return loginResponse();
      return new Response(JSON.stringify(data));
    });

    const result = await client.getFiles("abc123");
    expect(result).toEqual(data);
  });

  test("pause uses v5 endpoint when version >= 2.11", async () => {
    const client = new QbitClient();
    const calls: string[] = [];

    mockFetch((url, _opts) => {
      calls.push(url);
      if (url.includes("auth/login")) return loginResponse();
      if (url.includes("webapiVersion")) return new Response("2.11.0");
      if (url.includes("torrents/stop")) return new Response("Ok.");
      return new Response("Ok.");
    });

    await client.pause("abc123");
    expect(calls.some((c) => c.includes("torrents/stop"))).toBe(true);
  });

  test("pause uses v4 endpoint when version < 2.11", async () => {
    const client = new QbitClient();
    const calls: string[] = [];

    mockFetch((url) => {
      calls.push(url);
      if (url.includes("auth/login")) return loginResponse();
      if (url.includes("webapiVersion")) return new Response("2.8.0");
      if (url.includes("torrents/pause")) return new Response("Ok.");
      return new Response("Ok.");
    });

    await client.pause("abc123");
    expect(calls.some((c) => c.includes("torrents/pause"))).toBe(true);
  });

  test("resume uses v5 endpoint", async () => {
    const client = new QbitClient();
    const calls: string[] = [];

    mockFetch((url) => {
      calls.push(url);
      if (url.includes("auth/login")) return loginResponse();
      if (url.includes("webapiVersion")) return new Response("2.11.0");
      if (url.includes("torrents/start")) return new Response("Ok.");
      return new Response("Ok.");
    });

    await client.resume("abc123");
    expect(calls.some((c) => c.includes("torrents/start"))).toBe(true);
  });

  test("resume uses v4 endpoint", async () => {
    const client = new QbitClient();
    const calls: string[] = [];

    mockFetch((url) => {
      calls.push(url);
      if (url.includes("auth/login")) return loginResponse();
      if (url.includes("webapiVersion")) return new Response("2.8.0");
      if (url.includes("torrents/resume")) return new Response("Ok.");
      return new Response("Ok.");
    });

    await client.resume("abc123");
    expect(calls.some((c) => c.includes("torrents/resume"))).toBe(true);
  });

  test("delete", async () => {
    const client = new QbitClient();
    const calls: string[] = [];

    mockFetch((url, _opts) => {
      calls.push(url);
      if (url.includes("auth/login")) return loginResponse();
      if (url.includes("torrents/delete")) return new Response("Ok.");
      return new Response("Ok.");
    });

    await client.delete("abc123", true);
    expect(calls.some((c) => c.includes("torrents/delete"))).toBe(true);
  });

  test("retries login on 403", async () => {
    const client = new QbitClient();
    let loginCount = 0;

    mockFetch((url) => {
      if (url.includes("auth/login")) {
        loginCount++;
        return loginResponse();
      }
      if (url.includes("torrents/info")) {
        if (loginCount === 1) return new Response("Forbidden", { status: 403 });
        return new Response("[]");
      }
      return new Response("Ok.");
    });

    const result = await client.getTorrents("abc123");
    expect(loginCount).toBe(2);
    expect(result).toEqual([]);
  });

  test("login throws when no SID cookie", async () => {
    const client = new QbitClient();

    mockFetch((url) => {
      if (url.includes("auth/login")) return new Response("Ok.");
      return new Response("Ok.");
    });

    expect(client.getTorrents("abc123")).rejects.toThrow("no SID cookie");
  });

  test("login throws on failed response", async () => {
    const client = new QbitClient();

    mockFetch((url) => {
      if (url.includes("auth/login")) return new Response("error", { status: 401 });
      return new Response("Ok.");
    });

    expect(client.getTorrents("abc123")).rejects.toThrow("qBit login failed: 401");
  });

  test("formRequest throws on failure", async () => {
    const client = new QbitClient();

    mockFetch((url) => {
      if (url.includes("auth/login")) return loginResponse();
      if (url.includes("webapiVersion")) return new Response("2.11.0");
      return new Response("error", { status: 500 });
    });

    expect(client.pause("abc123")).rejects.toThrow("qBit torrents/stop failed: 500");
  });

  test("withCookie handles Headers instance", async () => {
    const client = new QbitClient();
    const calls: RequestInit[] = [];

    mockFetch((url, opts) => {
      if (url.includes("auth/login")) return loginResponse();
      calls.push(opts ?? {});
      return new Response("[]");
    });

    await client.getTorrents("abc123");
    const cookie = (calls[0]?.headers as Record<string, string>)?.Cookie;
    expect(cookie).toBe("SID=abc123");
  });

  test("withCookie handles array headers", async () => {
    const client = new QbitClient();

    mockFetch((url) => {
      if (url.includes("auth/login")) return loginResponse();
      if (url.includes("torrents/add")) return new Response("Ok.");
      return new Response("Ok.");
    });

    await client.addMagnet("magnet:?xt=urn:btih:test", "/tmp");
  });
});
