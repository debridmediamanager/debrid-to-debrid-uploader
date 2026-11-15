import { runCommand } from "./utils/command";

type CommandRunner = typeof runCommand;

export type MediaInfo = {
  video: {
    codec: string | null;
    width: number | null;
    height: number | null;
    bitDepth: number | null;
    hdr: string | null;
    dolbyVision: { profile: number; blCompatId: number | null } | null;
  } | null;
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
};

type AudioTrack = {
  language: string | null;
  codec: string | null;
  channels: number | null;
  title: string | null;
};

type SubtitleTrack = {
  language: string | null;
  format: string | null;
  title: string | null;
  forced: boolean;
};

type RawTrack = Record<string, unknown>;
type RawMediaInfo = { media?: { track?: RawTrack[] } };

export async function probeMediaInfo(
  filePath: string,
  commandRunner: CommandRunner = runCommand,
): Promise<MediaInfo> {
  let stdout = "";
  await commandRunner(["mediainfo", "--Output=JSON", filePath], {
    onOutput: (line) => {
      stdout += `${line}\n`;
    },
  });
  return parseMediaInfoJson(stdout);
}

export function parseMediaInfoJson(json: string): MediaInfo {
  const raw: RawMediaInfo = JSON.parse(json);
  const tracks = raw.media?.track ?? [];

  const videoTrack = tracks.find((t) => str(t["@type"]) === "Video");
  const audioTracks = tracks.filter((t) => str(t["@type"]) === "Audio");
  const textTracks = tracks.filter((t) => str(t["@type"]) === "Text");

  return {
    video: videoTrack ? parseVideo(videoTrack) : null,
    audio: audioTracks.map(parseAudio),
    subtitles: textTracks.map(parseSubtitle),
  };
}

function parseVideo(t: RawTrack) {
  return {
    codec: str(t.Format),
    width: num(t.Width),
    height: num(t.Height),
    bitDepth: num(t.BitDepth),
    hdr: detectHdr(t),
    dolbyVision: detectDolbyVision(t),
  };
}

function detectHdr(t: RawTrack): string | null {
  const hdrFormat = str(t.HDR_Format) || str(t.HDR_Format_String);
  const compat = str(t.HDR_Format_Compatibility);

  if (compat) {
    if (/HDR10\+/i.test(compat)) return "HDR10+";
    if (/HDR10/i.test(compat)) return "HDR10";
    if (/HLG/i.test(compat)) return "HLG";
  }

  if (hdrFormat) {
    if (/dolby\s*vision/i.test(hdrFormat)) return null;
    if (/HDR10\+/i.test(hdrFormat)) return "HDR10+";
    if (/HDR10/i.test(hdrFormat)) return "HDR10";
    if (/HLG/i.test(hdrFormat)) return "HLG";
    return hdrFormat;
  }

  const transferChar = str(t.transfer_characteristics);
  if (transferChar === "PQ" || transferChar === "SMPTE ST 2084") return "HDR10";
  if (transferChar === "HLG") return "HLG";
  return null;
}

function detectDolbyVision(t: RawTrack): { profile: number; blCompatId: number | null } | null {
  const hdrFormat = str(t.HDR_Format);
  if (!hdrFormat || !/dolby\s*vision/i.test(hdrFormat)) return null;

  const profile = str(t.HDR_Format_Profile);
  const profileMatch = profile?.match(/dvhe\.(\d+)/);
  if (!profileMatch) return null;

  const profileNum = parseInt(profileMatch[1], 10);
  const compatMatch = profile?.match(/dvhe\.\d+\.(\d+)/);
  const blCompatId = compatMatch ? parseInt(compatMatch[1], 10) : null;

  return { profile: profileNum, blCompatId };
}

function parseAudio(t: RawTrack): AudioTrack {
  return {
    language: str(t.Language),
    codec: str(t.Format),
    channels: num(t.Channels),
    title: str(t.Title),
  };
}

function parseSubtitle(t: RawTrack): SubtitleTrack {
  return {
    language: str(t.Language),
    format: str(t.Format),
    title: str(t.Title),
    forced: str(t.Forced)?.toLowerCase() === "yes",
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}
