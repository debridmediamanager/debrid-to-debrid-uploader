import { describe, expect, test } from "bun:test";
import { parseMediaInfoJson, probeMediaInfo } from "./mediainfo";

const sampleJson = JSON.stringify({
  media: {
    track: [
      { "@type": "General", Format: "Matroska" },
      {
        "@type": "Video",
        Format: "HEVC",
        Width: "3840",
        Height: "2160",
        BitDepth: "10",
        HDR_Format: "Dolby Vision, Version 1.0, dvhe.08.06, BL+RPU",
        HDR_Format_Profile: "dvhe.08",
        HDR_Format_Compatibility: "HDR10",
        HDR_Format_Commercial: "Dolby Vision HDR10",
        transfer_characteristics: "PQ",
      },
      { "@type": "Audio", Language: "en", Format: "E-AC-3", Channels: "6", Title: "English 5.1" },
      { "@type": "Audio", Language: "es", Format: "AAC", Channels: "2", Title: "Spanish Stereo" },
      {
        "@type": "Text",
        Language: "en",
        Format: "UTF-8",
        Title: "English",
        Forced: "No",
      },
      {
        "@type": "Text",
        Language: "en",
        Format: "UTF-8",
        Title: "English Forced",
        Forced: "Yes",
      },
    ],
  },
});

describe("parseMediaInfoJson", () => {
  test("parses video track with Dolby Vision and HDR", () => {
    const info = parseMediaInfoJson(sampleJson);
    expect(info.video).toEqual({
      codec: "HEVC",
      width: 3840,
      height: 2160,
      bitDepth: 10,
      hdr: "HDR10",
      dolbyVision: { profile: 8, blCompatId: null },
    });
  });

  test("parses audio tracks", () => {
    const info = parseMediaInfoJson(sampleJson);
    expect(info.audio).toHaveLength(2);
    expect(info.audio[0]).toEqual({
      language: "en",
      codec: "E-AC-3",
      channels: 6,
      title: "English 5.1",
    });
    expect(info.audio[1]).toEqual({
      language: "es",
      codec: "AAC",
      channels: 2,
      title: "Spanish Stereo",
    });
  });

  test("parses subtitle tracks", () => {
    const info = parseMediaInfoJson(sampleJson);
    expect(info.subtitles).toHaveLength(2);
    expect(info.subtitles[0].forced).toBe(false);
    expect(info.subtitles[1].forced).toBe(true);
  });

  test("handles missing video track", () => {
    const json = JSON.stringify({ media: { track: [{ "@type": "General" }] } });
    const info = parseMediaInfoJson(json);
    expect(info.video).toBeNull();
  });

  test("handles empty tracks", () => {
    const json = JSON.stringify({ media: { track: [] } });
    const info = parseMediaInfoJson(json);
    expect(info.video).toBeNull();
    expect(info.audio).toEqual([]);
    expect(info.subtitles).toEqual([]);
  });

  test("handles missing media key", () => {
    const info = parseMediaInfoJson("{}");
    expect(info.video).toBeNull();
    expect(info.audio).toEqual([]);
  });

  test("detects HDR10+ from compatibility field", () => {
    const json = JSON.stringify({
      media: {
        track: [{ "@type": "Video", Format: "HEVC", HDR_Format_Compatibility: "HDR10+" }],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video?.hdr).toBe("HDR10+");
  });

  test("detects HLG from compatibility field", () => {
    const json = JSON.stringify({
      media: {
        track: [{ "@type": "Video", Format: "HEVC", HDR_Format_Compatibility: "HLG" }],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video?.hdr).toBe("HLG");
  });

  test("detects HDR10 from transfer characteristics PQ", () => {
    const json = JSON.stringify({
      media: {
        track: [{ "@type": "Video", Format: "HEVC", transfer_characteristics: "PQ" }],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video?.hdr).toBe("HDR10");
  });

  test("detects HDR10 from SMPTE ST 2084 transfer characteristics", () => {
    const json = JSON.stringify({
      media: {
        track: [{ "@type": "Video", Format: "HEVC", transfer_characteristics: "SMPTE ST 2084" }],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video?.hdr).toBe("HDR10");
  });

  test("detects HLG from transfer characteristics", () => {
    const json = JSON.stringify({
      media: {
        track: [{ "@type": "Video", Format: "HEVC", transfer_characteristics: "HLG" }],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video?.hdr).toBe("HLG");
  });

  test("detects HDR10+ from HDR_Format field", () => {
    const json = JSON.stringify({
      media: {
        track: [{ "@type": "Video", Format: "HEVC", HDR_Format: "HDR10+ Profile A" }],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video?.hdr).toBe("HDR10+");
  });

  test("detects HDR10 from HDR_Format field", () => {
    const json = JSON.stringify({
      media: {
        track: [{ "@type": "Video", Format: "HEVC", HDR_Format: "HDR10" }],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video?.hdr).toBe("HDR10");
  });

  test("detects HLG from HDR_Format field", () => {
    const json = JSON.stringify({
      media: {
        track: [{ "@type": "Video", Format: "HEVC", HDR_Format: "HLG" }],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video?.hdr).toBe("HLG");
  });

  test("returns HDR_Format string when not a known format", () => {
    const json = JSON.stringify({
      media: {
        track: [{ "@type": "Video", Format: "HEVC", HDR_Format: "SomeOtherHDR" }],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video?.hdr).toBe("SomeOtherHDR");
  });

  test("detects HDR from HDR_Format_String fallback", () => {
    const json = JSON.stringify({
      media: {
        track: [{ "@type": "Video", Format: "HEVC", HDR_Format_String: "HDR10" }],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video?.hdr).toBe("HDR10");
  });

  test("DV-only returns null for hdr", () => {
    const json = JSON.stringify({
      media: {
        track: [
          {
            "@type": "Video",
            Format: "HEVC",
            HDR_Format: "Dolby Vision, dvhe.05",
            HDR_Format_Profile: "dvhe.05",
          },
        ],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video?.hdr).toBeNull();
    expect(info.video?.dolbyVision).toEqual({ profile: 5, blCompatId: null });
  });

  test("handles null/undefined fields gracefully", () => {
    const json = JSON.stringify({
      media: {
        track: [{ "@type": "Video" }, { "@type": "Audio" }, { "@type": "Text" }],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video).toEqual({
      codec: null,
      width: null,
      height: null,
      bitDepth: null,
      hdr: null,
      dolbyVision: null,
    });
    expect(info.audio[0]).toEqual({
      language: null,
      codec: null,
      channels: null,
      title: null,
    });
    expect(info.subtitles[0]).toEqual({
      language: null,
      format: null,
      title: null,
      forced: false,
    });
  });

  test("parses blCompatId from full profile string", () => {
    const json = JSON.stringify({
      media: {
        track: [
          {
            "@type": "Video",
            Format: "HEVC",
            HDR_Format: "Dolby Vision, dvhe.08.06",
            HDR_Format_Profile: "dvhe.08.06",
          },
        ],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video?.dolbyVision).toEqual({ profile: 8, blCompatId: 6 });
  });

  test("returns null for non-matching DV profile", () => {
    const json = JSON.stringify({
      media: {
        track: [
          {
            "@type": "Video",
            Format: "HEVC",
            HDR_Format: "Dolby Vision",
            HDR_Format_Profile: "no-match",
          },
        ],
      },
    });
    const info = parseMediaInfoJson(json);
    expect(info.video?.dolbyVision).toBeNull();
  });
});

describe("probeMediaInfo", () => {
  test("calls mediainfo and parses output", async () => {
    const mockRunner = async (cmd: string[], opts: { onOutput?: (line: string) => void }) => {
      expect(cmd[0]).toBe("mediainfo");
      expect(cmd[1]).toBe("--Output=JSON");
      opts.onOutput?.(sampleJson);
    };

    const info = await probeMediaInfo("/some/file.mkv", mockRunner as never);
    expect(info.video?.codec).toBe("HEVC");
    expect(info.audio).toHaveLength(2);
  });
});
