/**
 * A provider call was reached without the credential it needs.
 *
 * Every job carries its own keys and there is no operator fallback, so this is
 * not a condition the submission path can produce — `parseJobInput` refuses a
 * job with no Real-Debrid key or no cache-source key before a row is ever
 * written. It exists for the one case that can still get here: a job row created
 * *before* that rule, resumed from SQLite on boot.
 *
 * Failing loudly is the point. The fallback it replaces was silent — a job that
 * omitted `tb_api_key` ran perfectly well on the operator's TorBox account,
 * spending their quota and counting against their abuse threshold, and nothing
 * in the logs or the job row said so. One submission in seven was doing it.
 */
export class MissingCredentialError extends Error {
  constructor(provider: string) {
    super(`${provider} credentials are required; this job carries none`);
    this.name = "MissingCredentialError";
  }
}
