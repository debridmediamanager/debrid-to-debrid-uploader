import { config } from "./config";

/** Bun accepts a `proxy` on `RequestInit`; the lib this compiles against does not. */
export type TorboxRequestInit = RequestInit & { proxy?: string };

/**
 * Finish a request init for anything addressed to TorBox.
 *
 * Every TorBox-bound call goes through here — `api.torbox.app`,
 * `webdav.torbox.app` and the `requestdl` CDN links alike — so that the control
 * plane and the data plane present the same egress address and the same
 * `User-Agent`. They used to differ on both counts while sharing one API key,
 * which made the two halves of a job trivially joinable and cost the proxy most
 * of its value. Anything new that talks to TorBox belongs here too; a bare
 * `fetch` re-opens the gap silently, since nothing about it fails.
 *
 * The `proxy` key is added only when one is configured rather than set to
 * `undefined`: Bun treats a *present* `proxy` as a proxy request even when its
 * value is empty, so leaving the key in would break the unproxied default.
 */
export function torboxInit(init: TorboxRequestInit = {}): TorboxRequestInit {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", config.torboxUserAgent);
  const stamped = { ...init, headers };
  return config.torboxProxyUrl ? { ...stamped, proxy: config.torboxProxyUrl } : stamped;
}

/** `fetch` with `torboxInit` applied. */
export function torboxFetch(url: string, init: TorboxRequestInit = {}): Promise<Response> {
  return fetch(url, torboxInit(init));
}
