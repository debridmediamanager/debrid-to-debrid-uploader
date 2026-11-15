import { config } from "./config";

export type QbitTorrent = {
  progress: number;
  dlspeed: number;
  num_seeds: number;
  state: string;
  name?: string;
  /** `-1` until the `info` dict arrives, which is how metadata is detected. */
  total_size?: number;
};

export type QbitFile = {
  name: string;
  size: number;
};

export class QbitClient {
  private sid: string | null;
  private useV5Endpoints: boolean | null;

  constructor() {
    this.sid = null;
    this.useV5Endpoints = null;
  }

  async addMagnet(magnetUri: string, savePath: string, sequential = false): Promise<void> {
    const body = new URLSearchParams();
    body.set("urls", magnetUri);
    body.set("savepath", savePath);
    body.set("sequentialDownload", sequential ? "true" : "false");

    const res = await this.request("torrents/add", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`qBit add failed: ${res.status}`);
  }

  /**
   * Add a magnet to learn its `info` dict and nothing else.
   *
   * Deliberately unlike `addMagnet`: no save path and `skip_checking`, because
   * no payload is wanted. It is added **started** — a stopped torrent connects
   * to nobody, so it sits in `stoppedDL` forever and never learns anything
   * (measured: 120s, zero peers). Once the metadata lands the torrent settles
   * in `missingFiles`, having written no data, and is removed.
   */
  async addMagnetForMetadata(magnetUri: string): Promise<void> {
    const body = new URLSearchParams();
    body.set("urls", magnetUri);
    body.set("stopped", "false");
    body.set("skip_checking", "true");

    const res = await this.request("torrents/add", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`qBit metadata add failed: ${res.status}`);
  }

  /** The `.torrent` qBittorrent assembled, straight off the wire. */
  async exportTorrent(hash: string): Promise<Buffer> {
    const res = await this.request(`torrents/export?hash=${hash}`);
    if (!res.ok) throw new Error(`qBit export failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async getTorrents(hash: string): Promise<QbitTorrent[]> {
    const res = await this.request(`torrents/info?hashes=${hash}`);
    return (await res.json()) as QbitTorrent[];
  }

  async getFiles(hash: string): Promise<QbitFile[]> {
    const res = await this.request(`torrents/files?hash=${hash}`);
    return (await res.json()) as QbitFile[];
  }

  async pause(hash: string): Promise<void> {
    const endpoint = (await this.isV5()) ? "torrents/stop" : "torrents/pause";
    await this.formRequest(endpoint, `hashes=${hash}`);
  }

  async resume(hash: string): Promise<void> {
    const endpoint = (await this.isV5()) ? "torrents/start" : "torrents/resume";
    await this.formRequest(endpoint, `hashes=${hash}`);
  }

  async delete(hash: string, deleteFiles = false): Promise<void> {
    await this.formRequest("torrents/delete", `hashes=${hash}&deleteFiles=${deleteFiles}`);
  }

  async setFilePriority(hash: string, fileIds: number[], priority: number): Promise<void> {
    await this.formRequest(
      "torrents/filePrio",
      `hash=${hash}&id=${fileIds.join("|")}&priority=${priority}`,
    );
  }

  private async formRequest(endpoint: string, body: string): Promise<void> {
    const res = await this.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`qBit ${endpoint} failed: ${res.status}`);
  }

  private async request(
    endpoint: string,
    opts: RequestInit = {},
    retried = false,
  ): Promise<Response> {
    if (!this.sid) await this.login();

    const res = await fetch(`${config.qbitUrl}/api/v2/${endpoint}`, {
      ...opts,
      headers: this.withCookie(opts.headers),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 403 && !retried) {
      this.sid = null;
      return this.request(endpoint, opts, true);
    }
    return res;
  }

  private async isV5(): Promise<boolean> {
    if (this.useV5Endpoints === null) {
      const res = await this.request("app/webapiVersion");
      const parts = (await res.text()).trim().split(".").map(Number);
      this.useV5Endpoints = parts[0] > 2 || (parts[0] === 2 && parts[1] >= 11);
    }
    return this.useV5Endpoints;
  }

  private async login(): Promise<void> {
    const body = new URLSearchParams({
      username: config.qbitUsername,
      password: config.qbitPassword,
    });
    const res = await fetch(`${config.qbitUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`qBit login failed: ${res.status}`);
    const cookie = res.headers.get("set-cookie");
    const match = cookie?.match(/SID=([^;]+)/);
    if (!match) throw new Error("qBit login: no SID cookie");
    this.sid = match[1];
  }

  private withCookie(existing?: HeadersInit): Record<string, string> {
    const headers: Record<string, string> = {};
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      !(existing instanceof Headers)
    ) {
      Object.assign(headers, existing);
    }
    headers.Cookie = `SID=${this.sid}`;
    return headers;
  }
}
