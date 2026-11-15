export type MediaType = "movie" | "show";

export const DMM_METADATA_URL = "https://debridmediamanager.com";
const DMM_TIMEOUT_MS = 15_000;

export type MdbInfo = {
  title: string;
  year: number;
  type: MediaType;
};

export type Fetcher = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type MetadataSource = {
  key: string;
  fn: (imdbId: string, key: string, fetcher?: Fetcher) => Promise<MdbInfo>;
};

/**
 * DMM's canonical record for an imdb id. DMM merges TMDB, Trakt, MDBList,
 * Cinemeta, OMDb and TVmaze and caches the answer, so its year is the original
 * release (Spirited Away 2001, where OMDb says 2003) and its title the one
 * release names use. `key` is DMM's `METADATA_API_SECRET`.
 */
export async function fetchDmmInfo(
  imdbId: string,
  key: string,
  fetcher: Fetcher = fetch,
  baseUrl = DMM_METADATA_URL,
): Promise<MdbInfo> {
  const res = await fetcher(`${baseUrl}/api/metadata/${encodeURIComponent(imdbId)}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(DMM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DMM metadata error: ${res.status}`);
  const data = (await res.json()) as { type?: string; title?: string; year?: number | null };
  // An episode's id has no title/year of its own worth naming a file after.
  if ((data.type !== "movie" && data.type !== "show") || !data.title || !data.year) {
    throw new Error(`DMM metadata: no movie or show for ${imdbId}`);
  }
  return { title: data.title, year: data.year, type: data.type };
}

/**
 * DMM's resolution of a parsed release title to an imdb id. DMM checks every
 * candidate against its canonical record and answers a match only when the
 * title matches exactly and the year agrees, so it never hands back Saw III
 * for "Saw IV" the way MDBList's first search hit does. Null when DMM cannot
 * say, is unreachable, or is not configured.
 */
export async function resolveViaDmm(
  title: string,
  year: number | undefined,
  key: string,
  fetcher: Fetcher = fetch,
  baseUrl = DMM_METADATA_URL,
): Promise<{ imdbId: string; info: MdbInfo } | null> {
  if (!key) return null;
  const params = new URLSearchParams({ title });
  if (year !== undefined) params.set("year", String(year));
  try {
    const res = await fetcher(`${baseUrl}/api/metadata/resolve?${params}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(DMM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      confidence?: string;
      match?: { imdbId?: string; title?: string; year?: number | null; type?: string } | null;
    };
    const m = data.match;
    if (!m?.imdbId || !m.title || !m.year) return null;
    // "near" is a year one off (festival vs release); "title" had no year to check.
    if (!["exact", "near", "title"].includes(data.confidence ?? "")) return null;
    return {
      imdbId: m.imdbId,
      info: { title: m.title, year: m.year, type: m.type === "movie" ? "movie" : "show" },
    };
  } catch {
    return null;
  }
}

export async function fetchMdbInfo(
  imdbId: string,
  apiKey: string,
  fetcher: Fetcher = fetch,
): Promise<MdbInfo> {
  const url = `https://mdblist.com/api/?apikey=${apiKey}&i=${imdbId}`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`MDBList API error: ${res.status}`);
  const data = (await res.json()) as {
    title?: string;
    year?: number;
    type?: string;
    response?: boolean;
  };
  if (!data.response || !data.title || !data.year) {
    throw new Error(`MDBList: no result for ${imdbId}`);
  }
  return {
    title: data.title,
    year: data.year,
    type: data.type === "movie" ? "movie" : "show",
  };
}

export async function fetchOmdbInfo(
  imdbId: string,
  apiKey: string,
  fetcher: Fetcher = fetch,
): Promise<MdbInfo> {
  const url = `https://www.omdbapi.com/?apikey=${apiKey}&i=${imdbId}`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`OMDB API error: ${res.status}`);
  const data = (await res.json()) as {
    Title?: string;
    Year?: string;
    Type?: string;
    Response?: string;
  };
  if (data.Response !== "True" || !data.Title || !data.Year) {
    throw new Error(`OMDB: no result for ${imdbId}`);
  }
  return {
    title: data.Title,
    year: Number.parseInt(data.Year, 10),
    type: data.Type === "movie" ? "movie" : "show",
  };
}

export async function fetchTmdbInfo(
  imdbId: string,
  apiKey: string,
  fetcher: Fetcher = fetch,
): Promise<MdbInfo> {
  const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`TMDB API error: ${res.status}`);
  const data = (await res.json()) as {
    movie_results?: { title: string; release_date: string }[];
    tv_results?: { name: string; first_air_date: string }[];
  };
  if (data.movie_results?.length) {
    const m = data.movie_results[0];
    return {
      title: m.title,
      year: Number.parseInt(m.release_date?.slice(0, 4), 10),
      type: "movie",
    };
  }
  if (data.tv_results?.length) {
    const t = data.tv_results[0];
    return {
      title: t.name,
      year: Number.parseInt(t.first_air_date?.slice(0, 4), 10),
      type: "show",
    };
  }
  throw new Error(`TMDB: no result for ${imdbId}`);
}

type SearchResult = {
  imdbid?: string;
  title?: string;
  year?: number;
  type?: string;
};

/** Normalise a title for comparison: lowercase, alphanumerics only. */
function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * MDBList's `?s=` search is fuzzy — a query for "Saw IV" also returns Saw III
 * and Saw V — and does not filter by `?y=`. So the year and title are matched
 * here: prefer an exact title at the right year, then any result at that year,
 * then an exact title, then the top result.
 */
function pickBest(results: SearchResult[], title: string, year?: number): SearchResult | null {
  const withImdb = results.filter((r) => r.imdbid && r.title && r.year);
  if (withImdb.length === 0) return null;
  const want = normTitle(title);

  if (year !== undefined) {
    const atYear = withImdb.filter((r) => r.year === year);
    const exact = atYear.find((r) => normTitle(r.title as string) === want);
    if (exact) return exact;
    if (atYear.length > 0) return atYear[0];
  }
  return withImdb.find((r) => normTitle(r.title as string) === want) ?? withImdb[0];
}

/**
 * Resolve a parsed release title (and optional year) to an imdb id *and* its
 * metadata in one call. Returns null when nothing matches, so a magnet with no
 * imdb id can still be identified from its name. Best-effort: an HTTP error
 * yields null rather than throwing.
 */
export async function searchMedia(
  title: string,
  year: number | undefined,
  apiKey: string,
  fetcher: Fetcher = fetch,
): Promise<{ imdbId: string; info: MdbInfo } | null> {
  const params = new URLSearchParams({ apikey: apiKey, s: title });
  if (year !== undefined) params.set("y", String(year));
  const res = await fetcher(`https://mdblist.com/api/?${params}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { search?: SearchResult[] };
  const best = pickBest(data.search ?? [], title, year);
  if (!best) return null;
  return {
    imdbId: best.imdbid as string,
    info: {
      title: best.title as string,
      year: best.year as number,
      type: best.type === "movie" ? "movie" : "show",
    },
  };
}

/**
 * Metadata from the first source, in the order given, that answers.
 *
 * The sources are asked at once, but the answer is taken by rank rather than by
 * arrival: they disagree, and the fastest is not the most accurate. OMDb gives a
 * film's US release year, so Spirited Away came back as 2003 whenever OMDb beat
 * MDBList and TMDB (2001) to the response, and the file was named for a year no
 * release name or Plex agent uses. A lower-ranked answer is used only once every
 * source above it has failed.
 */
export async function fetchMediaInfo(
  imdbId: string,
  sources: MetadataSource[],
  fetcher: Fetcher = fetch,
): Promise<MdbInfo> {
  const configured = sources.filter((s) => s.key);
  if (configured.length === 0) throw new Error("No metadata API keys configured");

  const attempts = configured.map((s) =>
    s.fn(imdbId, s.key, fetcher).then(
      (info) => ({ ok: true as const, info }),
      (error: Error) => ({ ok: false as const, error }),
    ),
  );
  const errors: string[] = [];
  for (const attempt of attempts) {
    const result = await attempt;
    if (result.ok) return result.info;
    errors.push(result.error.message);
  }
  throw new Error(`All metadata sources failed for ${imdbId}: ${errors.join("; ")}`);
}
