import { afterEach, describe, expect, mock, test } from "bun:test";
import { clearTrackerCache, enrichMagnet, getTrackers } from "./trackers";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearTrackerCache();
});

describe("tracker helpers", () => {
  test("fetches trackers once and caches them", async () => {
    const fetchMock = mock(async () => new Response("udp://one\n\nudp://two\n"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await getTrackers()).toEqual(["udp://one", "udp://two"]);
    expect(await getTrackers()).toEqual(["udp://one", "udp://two"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("returns the last cache value when refresh fails", async () => {
    const fetchMock = mock(async () => {
      throw new Error("network down");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await getTrackers()).toEqual([]);
  });

  test("enriches magnets that do not already include trackers", async () => {
    expect(enrichMagnet("magnet:?xt=urn:btih:abc", ["udp://one"])).toBe(
      "magnet:?xt=urn:btih:abc&tr=udp%3A%2F%2Fone",
    );
  });

  test("does not duplicate existing trackers", async () => {
    const magnet = "magnet:?xt=urn:btih:abc&tr=udp%3A%2F%2Fexisting";

    expect(enrichMagnet(magnet, ["udp://one"])).toBe(magnet);
    expect(enrichMagnet("magnet:?xt=urn:btih:abc", [])).toBe("magnet:?xt=urn:btih:abc");
  });
});
