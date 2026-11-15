import { afterEach, describe, expect, mock, test } from "bun:test";
import { config } from "./config";
import { type TorboxRequestInit, torboxFetch, torboxInit } from "./torbox-http";

const originalProxy = config.torboxProxyUrl;
const originalUserAgent = config.torboxUserAgent;
const originalFetch = globalThis.fetch;

afterEach(() => {
  config.torboxProxyUrl = originalProxy;
  config.torboxUserAgent = originalUserAgent;
  globalThis.fetch = originalFetch;
});

describe("torboxInit", () => {
  test("stamps the configured User-Agent in place of Bun's default", () => {
    // Left alone, Bun sends `Bun/<version>` — a stable identifier that outlives
    // any change of egress address, which is why proxying alone was half a fix.
    config.torboxUserAgent = "rclone/v1.74.1";
    expect(new Headers(torboxInit().headers).get("User-Agent")).toBe("rclone/v1.74.1");
  });

  test("keeps the caller's own headers and init fields", () => {
    config.torboxUserAgent = "rclone/v1.74.1";
    const init = torboxInit({ method: "POST", headers: { Authorization: "Bearer key" } });
    const headers = new Headers(init.headers);

    expect(init.method).toBe("POST");
    expect(headers.get("Authorization")).toBe("Bearer key");
    expect(headers.get("User-Agent")).toBe("rclone/v1.74.1");
  });

  test("routes through the proxy when one is configured", () => {
    config.torboxProxyUrl = "http://127.0.0.1:8118";
    expect(torboxInit().proxy).toBe("http://127.0.0.1:8118");
  });

  test("omits the proxy key entirely when none is configured", () => {
    // Not `proxy: undefined`: Bun treats a *present* key as a proxy request even
    // when its value is empty, so leaving it in would break the direct default.
    config.torboxProxyUrl = "";
    expect("proxy" in torboxInit()).toBe(false);
  });
});

describe("torboxFetch", () => {
  test("carries the proxy and User-Agent into the underlying fetch", async () => {
    config.torboxProxyUrl = "http://127.0.0.1:8118";
    config.torboxUserAgent = "rclone/v1.74.1";
    let seen: TorboxRequestInit | undefined;
    globalThis.fetch = mock(async (_url: string, init: TorboxRequestInit) => {
      seen = init;
      return new Response("ok");
    }) as unknown as typeof fetch;

    const res = await torboxFetch("https://api.torbox.app/v1/api/torrents/mylist");

    expect(await res.text()).toBe("ok");
    expect(seen?.proxy).toBe("http://127.0.0.1:8118");
    expect(new Headers(seen?.headers).get("User-Agent")).toBe("rclone/v1.74.1");
  });
});
