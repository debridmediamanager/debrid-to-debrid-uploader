const TRACKERS_URL =
  "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best_ip.txt";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cachedTrackers: string[] = [];
let trackersLastFetch = 0;

export function clearTrackerCache(): void {
  cachedTrackers = [];
  trackersLastFetch = 0;
}

export async function getTrackers(): Promise<string[]> {
  const now = Date.now();
  if (cachedTrackers.length > 0 && now - trackersLastFetch < CACHE_TTL_MS) {
    return cachedTrackers;
  }
  try {
    const res = await fetch(TRACKERS_URL);
    const text = await res.text();
    cachedTrackers = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    trackersLastFetch = now;
    console.log(`[trackers] fetched ${cachedTrackers.length} trackers`);
  } catch (err) {
    console.log(`[trackers] fetch failed: ${err}`);
  }
  return cachedTrackers;
}

export function enrichMagnet(magnetUri: string, trackers: string[]): string {
  if (trackers.length === 0) return magnetUri;
  const existing = new Set<string>();
  for (const match of magnetUri.matchAll(/[&?]tr=([^&]+)/g)) {
    existing.add(decodeURIComponent(match[1]));
  }
  if (existing.size > 0) return magnetUri;
  const params = trackers.map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join("");
  return magnetUri + params;
}
