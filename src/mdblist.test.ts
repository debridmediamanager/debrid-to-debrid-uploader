import { describe, expect, test } from "bun:test";
import dmmSpirited from "./fixtures/metadata/dmm-metadata-tt0245429-spirited-away.json";
import dmmResolveSawIv from "./fixtures/metadata/dmm-resolve-saw-iv-2007.json";
import mdblistSpirited from "./fixtures/metadata/mdblist-tt0245429-spirited-away.json";
import omdbSpirited from "./fixtures/metadata/omdb-tt0245429-spirited-away.json";
import mdblistSearchSawIv from "./fixtures/metadata/search-mdblist-saw-iv-2007.json";
import tmdbFindSpirited from "./fixtures/metadata/tmdb-find-tt0245429-spirited-away.json";
import {
  type Fetcher,
  fetchDmmInfo,
  fetchMdbInfo,
  fetchMediaInfo,
  fetchOmdbInfo,
  fetchTmdbInfo,
  type MetadataSource,
  resolveViaDmm,
  searchMedia,
} from "./mdblist";

function mockFetcher(body: unknown, ok = true, status = 200) {
  return async () => ({ ok, status, json: async () => body });
}

describe("fetchMdbInfo", () => {
  test("returns show info", async () => {
    const fetcher = mockFetcher({ title: "Test Show", year: 2020, type: "show", response: true });
    const info = await fetchMdbInfo("tt1234567", "fake-key", fetcher);
    expect(info).toEqual({ title: "Test Show", year: 2020, type: "show" });
  });

  test("returns movie info", async () => {
    const fetcher = mockFetcher({ title: "Inception", year: 2010, type: "movie", response: true });
    const info = await fetchMdbInfo("tt1375666", "fake-key", fetcher);
    expect(info).toEqual({ title: "Inception", year: 2010, type: "movie" });
  });

  test("maps non-movie types to show", async () => {
    const fetcher = mockFetcher({ title: "Anime", year: 2021, type: "series", response: true });
    const info = await fetchMdbInfo("tt9999999", "fake-key", fetcher);
    expect(info.type).toBe("show");
  });

  test("throws on API error", async () => {
    const fetcher = mockFetcher({}, false, 403);
    await expect(fetchMdbInfo("tt1234567", "bad-key", fetcher)).rejects.toThrow(
      "MDBList API error: 403",
    );
  });

  test("throws when response is false", async () => {
    const fetcher = mockFetcher({ response: false });
    await expect(fetchMdbInfo("tt0000000", "key", fetcher)).rejects.toThrow("no result");
  });
});

describe("fetchOmdbInfo", () => {
  test("returns movie info", async () => {
    const fetcher = mockFetcher({
      Title: "Inception",
      Year: "2010",
      Type: "movie",
      Response: "True",
    });
    const info = await fetchOmdbInfo("tt1375666", "key", fetcher);
    expect(info).toEqual({ title: "Inception", year: 2010, type: "movie" });
  });

  test("returns show info", async () => {
    const fetcher = mockFetcher({
      Title: "Breaking Bad",
      Year: "2008",
      Type: "series",
      Response: "True",
    });
    const info = await fetchOmdbInfo("tt0903747", "key", fetcher);
    expect(info).toEqual({ title: "Breaking Bad", year: 2008, type: "show" });
  });

  test("throws on API error", async () => {
    const fetcher = mockFetcher({}, false, 401);
    await expect(fetchOmdbInfo("tt1234567", "bad-key", fetcher)).rejects.toThrow(
      "OMDB API error: 401",
    );
  });

  test("throws when Response is False", async () => {
    const fetcher = mockFetcher({ Response: "False" });
    await expect(fetchOmdbInfo("tt0000000", "key", fetcher)).rejects.toThrow("OMDB: no result");
  });
});

describe("fetchTmdbInfo", () => {
  test("returns movie info", async () => {
    const fetcher = mockFetcher({
      movie_results: [{ title: "Inception", release_date: "2010-07-16" }],
      tv_results: [],
    });
    const info = await fetchTmdbInfo("tt1375666", "key", fetcher);
    expect(info).toEqual({ title: "Inception", year: 2010, type: "movie" });
  });

  test("returns show info", async () => {
    const fetcher = mockFetcher({
      movie_results: [],
      tv_results: [{ name: "Breaking Bad", first_air_date: "2008-01-20" }],
    });
    const info = await fetchTmdbInfo("tt0903747", "key", fetcher);
    expect(info).toEqual({ title: "Breaking Bad", year: 2008, type: "show" });
  });

  test("throws on API error", async () => {
    const fetcher = mockFetcher({}, false, 401);
    await expect(fetchTmdbInfo("tt1234567", "bad-key", fetcher)).rejects.toThrow(
      "TMDB API error: 401",
    );
  });

  test("throws when no results", async () => {
    const fetcher = mockFetcher({ movie_results: [], tv_results: [] });
    await expect(fetchTmdbInfo("tt0000000", "key", fetcher)).rejects.toThrow("TMDB: no result");
  });
});

describe("fetchMediaInfo", () => {
  const okSource = (key: string): MetadataSource => ({
    key,
    fn: async () => ({ title: "Movie", year: 2020, type: "movie" }),
  });

  const failSource = (key: string): MetadataSource => ({
    key,
    fn: async () => {
      throw new Error("source failed");
    },
  });

  test("returns first successful result", async () => {
    const sources = [failSource("key1"), okSource("key2")];
    const info = await fetchMediaInfo("tt1234567", sources);
    expect(info).toEqual({ title: "Movie", year: 2020, type: "movie" });
  });

  test("throws when all sources fail", async () => {
    const sources = [failSource("key1"), failSource("key2")];
    await expect(fetchMediaInfo("tt1234567", sources)).rejects.toThrow(
      "All metadata sources failed",
    );
  });

  test("throws when no sources configured", async () => {
    await expect(fetchMediaInfo("tt1234567", [])).rejects.toThrow(
      "No metadata API keys configured",
    );
  });

  test("skips sources with empty keys", async () => {
    const sources = [failSource(""), okSource("key2")];
    const info = await fetchMediaInfo("tt1234567", sources);
    expect(info).toEqual({ title: "Movie", year: 2020, type: "movie" });
  });

  test("fails when only empty-key sources exist", async () => {
    const sources = [okSource(""), failSource("")];
    await expect(fetchMediaInfo("tt1234567", sources)).rejects.toThrow(
      "No metadata API keys configured",
    );
  });
});

describe("searchMedia", () => {
  const sawResults = {
    search: [
      { imdbid: "tt0489270", title: "Saw III", year: 2006, type: "movie" },
      { imdbid: "tt0890870", title: "Saw IV", year: 2007, type: "movie" },
      { imdbid: "tt1132626", title: "Saw V", year: 2008, type: "movie" },
    ],
  };

  test("matches the exact title at the right year, not the top result", async () => {
    const found = await searchMedia("Saw IV", 2007, "k", mockFetcher(sawResults));
    expect(found).toEqual({
      imdbId: "tt0890870",
      info: { title: "Saw IV", year: 2007, type: "movie" },
    });
  });

  test("passes the query and year to MDBList", async () => {
    let seen = "";
    const fetcher = async (url: string) => {
      seen = url;
      return { ok: true, status: 200, json: async () => sawResults };
    };
    await searchMedia("Saw IV", 2007, "k", fetcher);
    expect(seen).toContain("s=Saw+IV");
    expect(seen).toContain("y=2007");
  });

  test("falls back to any result at the year when no title matches", async () => {
    const found = await searchMedia("Saww IV", 2007, "k", mockFetcher(sawResults));
    expect(found?.imdbId).toBe("tt0890870");
  });

  test("with no year, prefers an exact title match", async () => {
    const found = await searchMedia("Saw V", undefined, "k", mockFetcher(sawResults));
    expect(found?.imdbId).toBe("tt1132626");
  });

  test("with no year and no exact title, takes the top result", async () => {
    const found = await searchMedia("Saw", undefined, "k", mockFetcher(sawResults));
    expect(found?.imdbId).toBe("tt0489270");
  });

  test("maps a show result type", async () => {
    const found = await searchMedia(
      "Some Show",
      2020,
      "k",
      mockFetcher({ search: [{ imdbid: "tt5", title: "Some Show", year: 2020, type: "show" }] }),
    );
    expect(found?.info.type).toBe("show");
  });

  test("returns null when the search is empty", async () => {
    expect(await searchMedia("Nope", 1999, "k", mockFetcher({ search: [] }))).toBeNull();
  });

  test("returns null when results lack an imdb id", async () => {
    expect(
      await searchMedia("X", 1999, "k", mockFetcher({ search: [{ title: "X", year: 1999 }] })),
    ).toBeNull();
  });

  test("returns null on an HTTP error rather than throwing", async () => {
    expect(await searchMedia("X", 1999, "k", mockFetcher({}, false, 500))).toBeNull();
  });
});

// Real provider answers for tt0245429, captured 2026-09-26: OMDb says 2003 (the
// US release), MDBList and TMDB say 2001, as do the release names and Plex.

/** Serves each provider's captured body, OMDb first and the rest a little later. */
function providerFetcher(bodies: {
  omdb?: unknown;
  mdblist?: unknown;
  tmdb?: unknown;
  dmm?: unknown;
}) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const [body, delay] = url.includes("omdbapi.com")
      ? [bodies.omdb, 0]
      : url.includes("mdblist.com")
        ? [bodies.mdblist, 20]
        : url.includes("themoviedb.org")
          ? [bodies.tmdb, 20]
          : [bodies.dmm, 20];
    await new Promise((r) => setTimeout(r, delay));
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 503,
      json: async () => body,
    };
  };
  return { fetcher, calls };
}

describe("fetchMediaInfo ranks sources rather than racing them", () => {
  const sources: MetadataSource[] = [
    { key: "mdb", fn: fetchMdbInfo },
    { key: "tmdb", fn: fetchTmdbInfo },
    { key: "omdb", fn: fetchOmdbInfo },
  ];

  test("names Spirited Away for 2001 even when OMDb (2003) answers first", async () => {
    const { fetcher } = providerFetcher({
      omdb: omdbSpirited,
      mdblist: mdblistSpirited,
      tmdb: tmdbFindSpirited,
    });
    const info = await fetchMediaInfo("tt0245429", sources, fetcher);
    expect(info).toEqual({ title: "Spirited Away", year: 2001, type: "movie" });
  });

  test("falls to OMDb only when every source above it fails", async () => {
    const { fetcher } = providerFetcher({ omdb: omdbSpirited });
    const info = await fetchMediaInfo("tt0245429", sources, fetcher);
    expect(info.year).toBe(2003);
  });
});

describe("fetchDmmInfo", () => {
  test("reads DMM's canonical record and sends the secret", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetcher: Fetcher = async (_url, init) => {
      seen.push(init?.headers);
      return { ok: true, status: 200, json: async () => dmmSpirited };
    };
    const info = await fetchDmmInfo("tt0245429", "s3cret", fetcher, "https://dmm.test");
    expect(info).toEqual({ title: "Spirited Away", year: 2001, type: "movie" });
    expect(seen[0]).toEqual({ Authorization: "Bearer s3cret" });
  });

  test("refuses an episode record and a non-200", async () => {
    const episode = mockFetcher({ type: "episode", title: "Cake Week", seriesImdbId: "tt1877368" });
    await expect(fetchDmmInfo("tt21958588", "k", episode)).rejects.toThrow("no movie or show");
    await expect(fetchDmmInfo("tt0245429", "k", mockFetcher({}, false, 401))).rejects.toThrow(
      "401",
    );
  });

  test("outranks the direct sources when configured", async () => {
    const { fetcher } = providerFetcher({ omdb: omdbSpirited, dmm: dmmSpirited });
    const info = await fetchMediaInfo(
      "tt0245429",
      [
        { key: "secret", fn: (id, key, f) => fetchDmmInfo(id, key, f, "https://dmm.test") },
        { key: "omdb", fn: fetchOmdbInfo },
      ],
      fetcher,
    );
    expect(info.year).toBe(2001);
  });
});

describe("resolveViaDmm", () => {
  // MDBList's first hit for "Saw IV" is Saw III; DMM answers the right title.
  test("resolves Saw IV (2007) where MDBList's first hit is Saw III", async () => {
    expect((mdblistSearchSawIv as { search: Array<{ title: string }> }).search[0].title).toBe(
      "Saw III",
    );
    const found = await resolveViaDmm("Saw IV", 2007, "k", mockFetcher(dmmResolveSawIv));
    expect(found).toEqual({
      imdbId: "tt0890870",
      info: { title: "Saw IV", year: 2007, type: "movie" },
    });
  });

  test("answers null when DMM is unsure, unreachable, or unconfigured", async () => {
    const ambiguous = mockFetcher({ confidence: "ambiguous", match: null, candidates: [] });
    expect(await resolveViaDmm("Dune", undefined, "k", ambiguous)).toBeNull();
    const down: Fetcher = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await resolveViaDmm("Dune", 2021, "k", down)).toBeNull();
    expect(await resolveViaDmm("Dune", 2021, "", mockFetcher(dmmResolveSawIv))).toBeNull();
  });
});
