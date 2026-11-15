import * as alldebrid from "./alldebrid";
import { config } from "./config";
import * as premiumize from "./premiumize";
import * as rd from "./realdebrid";
import * as torbox from "./torbox";

/**
 * Which accounts a job belongs to, across every provider it names.
 *
 * **The concurrent-job limit counts the Real-Debrid account only** (see
 * `getActiveJobsForRdOwner`); the TorBox side is recorded as an audit trail of
 * whose quota paid for a job, not as a second thing to count. RD is the identity
 * every job has, and the one the submitter chose deliberately.
 *
 * `adUserId` is resolved but **not stored**: nothing counts against the
 * AllDebrid account, so there is no column for it. It exists because
 * `isUnlimitedOwner` asks a different question from the limit — "is any account
 * on this job an exempt one" — and answering that from two of the three keys
 * would miss a job submitted under an exempt AllDebrid account with somebody
 * else's RD destination.
 *
 * Either way it is scoped to the resolved *account* rather than to the API key
 * that produced it. Keys are not identities: TorBox rotates its key on every
 * abuse warning, and one person can hold several, so a per-key limit resets
 * itself at the worst possible moment and is trivially sidestepped by submitting
 * under a second key for the same account.
 */
export type JobOwners = {
  tbUserId: string;
  rdUserId: string;
  adUserId: string;
  pmUserId: string;
};

/** Injection seam so tests never reach the network. */
export type OwnerLookups = {
  torboxUser: (apiKey?: string) => Promise<{ id: number }>;
  rdUser: (apiKey?: string) => Promise<{ id: number }>;
  alldebridUser: (apiKey?: string) => Promise<{ id: string }>;
  premiumizeUser: (apiKey?: string) => Promise<{ id: string }>;
};

/**
 * The real provider calls, exported so the wiring itself is testable — with the
 * seam left unexported, every test injects a stub and nothing ever checks that
 * the default actually reaches TorBox, RD and AllDebrid.
 */
export const liveLookups: OwnerLookups = {
  torboxUser: (apiKey) => torbox.getCurrentUser({ apiKey }),
  rdUser: (apiKey) => rd.getUser({ apiKey }),
  // AllDebrid has no numeric account id; the username is the identity, so it is
  // mapped onto the same `{id}` shape the other two return.
  alldebridUser: (apiKey) => alldebrid.getUser({ apiKey }).then((user) => ({ id: user.username })),
  // Premiumize's customer id is already a string, so it needs no mapping.
  premiumizeUser: (apiKey) => premiumize.getCurrentUser({ apiKey }),
};

/**
 * Resolved owner strings, keyed by the credential that produced them.
 *
 * Holds the in-flight *promise* rather than the settled value so that a burst of
 * submissions on one key makes one lookup rather than one per job. Entries never
 * expire: an API key's account does not change under it, and the process is
 * restarted often enough that a stale entry is not a real risk.
 */
const cache = new Map<string, Promise<string>>();

/** Test seam: drop resolved owners so a test controls what gets looked up. */
export function _clearOwnerCache(): void {
  cache.clear();
}

function fallbackId(provider: string, key: string): string {
  // Distinct from the resolved form (`tb:123`) on purpose, so a degraded entry
  // is visible in the job row rather than passing for a real account id.
  const digest = new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 12);
  return `${provider}:key:${digest}`;
}

async function resolve(
  provider: string,
  key: string,
  lookup: () => Promise<{ id: number | string }>,
): Promise<string> {
  const cacheKey = `${provider}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const pending = lookup()
    .then((user) => `${provider}:${user.id}`)
    .catch((err) => {
      // Never fail a submission because an identity lookup did. Falling back to
      // the key's digest keeps the limit *enforced* — degraded to per-key rather
      // than per-account — where returning nothing would quietly disable it for
      // whichever account is having a bad minute, which is the wrong way to fail.
      cache.delete(cacheKey);
      console.warn(`[owners] ${provider} lookup failed, limiting by key instead: ${err}`);
      return fallbackId(provider, key);
    });

  cache.set(cacheKey, pending);
  return pending;
}

/**
 * Resolve both owners for a submission, using the shared env credential wherever
 * the job did not bring its own — which is what makes every operator-submitted
 * job share one owner on each side.
 */
export async function resolveJobOwners(
  creds: { tbApiKey?: string; rdApiKey?: string; adApiKey?: string; pmApiKey?: string },
  lookups: OwnerLookups = liveLookups,
): Promise<JobOwners> {
  // Any side may legitimately be absent, and which one depends on the
  // direction: an RD-destination job can source from AllDebrid and bring no
  // TorBox key, and a TorBox-destination job can do the same and bring no RD
  // key. The missing side is simply not resolved rather than resolved to
  // somebody. `""` is the query sentinel because a stored owner is always either
  // NULL or `<provider>:<id>`, so it can never collide.
  const [tbUserId, rdUserId, adUserId, pmUserId] = await Promise.all([
    creds.tbApiKey
      ? resolve("tb", creds.tbApiKey, () => lookups.torboxUser(creds.tbApiKey))
      : Promise.resolve(""),
    creds.rdApiKey
      ? resolve("rd", creds.rdApiKey, () => lookups.rdUser(creds.rdApiKey))
      : Promise.resolve(""),
    creds.adApiKey
      ? resolve("ad", creds.adApiKey, () => lookups.alldebridUser(creds.adApiKey))
      : Promise.resolve(""),
    creds.pmApiKey
      ? resolve("pm", creds.pmApiKey, () => lookups.premiumizeUser(creds.pmApiKey))
      : Promise.resolve(""),
  ]);

  return { tbUserId, rdUserId, adUserId, pmUserId };
}

/**
 * Whether this job's accounts put it outside the per-user limit.
 *
 * **Every provider on the job is checked, not just the one the limit counts.**
 * The limit asks "how much of the pipeline is this destination account already
 * occupying"; this asks the different question "is this the operator". Someone
 * running the service reaches it from whichever account is convenient — an
 * AllDebrid-sourced job whose RD destination is a second account of theirs is
 * the same person, and checking only the counted side would throttle them for
 * using their own service the way it is meant to be used.
 *
 * A degraded owner (`ad:key:<digest>`, from a failed identity lookup) matches
 * nothing in the list, so a provider outage revokes the exemption rather than
 * granting it — the same direction `resolve` already fails in. An unresolved
 * side is `""` and is skipped outright, or an empty entry in the env list would
 * exempt every job that omitted a key.
 */
export function isUnlimitedOwner(
  owners: JobOwners,
  unlimited: ReadonlySet<string> = config.unlimitedOwners,
): boolean {
  if (unlimited.size === 0) return false;
  return [owners.rdUserId, owners.tbUserId, owners.adUserId, owners.pmUserId].some(
    (owner) => owner !== "" && unlimited.has(owner),
  );
}

/**
 * Whether a submission claimed sponsorship.
 *
 * Trusted from the caller, which on this service means the private network: the
 * full API is unauthenticated and reachable only from there, exactly like the
 * provider API keys already accepted on this route. dmm verifies the
 * sponsorship — a token it signed itself — and vouches by setting this.
 *
 * Both spellings are accepted so a form-encoded or query-string caller behaves
 * like the JSON one; anything else is a non-sponsor, because a flag that grants
 * something defaults closed.
 */
export function claimsSponsor(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

/**
 * How many jobs this submitter may have in the pipeline at once.
 *
 * `null` means no limit — the operator exemption. Sponsorship raises the
 * ceiling; it never removes it, and it never touches `maxConcurrentJobs`, which
 * is what actually protects the TorBox slots.
 */
export function jobLimitFor(
  owners: JobOwners,
  sponsor: boolean,
  limits: { normal: number; sponsor: number } = {
    normal: config.maxJobsPerUser,
    sponsor: config.maxJobsPerUserSponsor,
  },
  unlimited: ReadonlySet<string> = config.unlimitedOwners,
): number | null {
  if (isUnlimitedOwner(owners, unlimited)) return null;
  // Max rather than the sponsor number outright: a deployment that raised
  // MAX_JOBS_PER_USER above the sponsor default must not demote sponsors.
  return sponsor ? Math.max(limits.sponsor, limits.normal) : limits.normal;
}
