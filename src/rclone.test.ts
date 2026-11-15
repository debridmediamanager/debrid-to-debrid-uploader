import { afterEach, describe, expect, mock, test } from "bun:test";
import { r2WebseedUrl, uploadToR2 } from "./rclone";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  mock.restore();
});

describe("uploadToR2", () => {
  test("calls rclone copy with correct args", async () => {
    const calls: string[][] = [];
    const mockRunner = async (cmd: string[]) => {
      calls.push(cmd);
    };

    const result = await uploadToR2("/tmp/files", "job-123", mockRunner as never);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("rclone");
    expect(calls[0][1]).toBe("copy");
    expect(calls[0][2]).toBe("--s3-no-check-bucket");
    expect(calls[0][3]).toBe("/tmp/files");
    expect(calls[0][4]).toBe("r2:dbrd/job-123");
    expect(result).toBe("https://upload.debridmediamanager.com/job-123");
  });

  test("uses cp when R2_MOUNT_PATH is set", async () => {
    const { config } = await import("./config");
    (config as { r2MountPath: string }).r2MountPath = "/mnt/r2";

    const calls: string[][] = [];
    const mockRunner = async (cmd: string[]) => {
      calls.push(cmd);
    };

    const result = await uploadToR2("/tmp/files", "job-456", mockRunner as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["cp", "-r", "/tmp/files", "/mnt/r2/job-456"]);
    expect(result).toBe("https://upload.debridmediamanager.com/job-456");

    (config as { r2MountPath: string }).r2MountPath = "";
  });

  test("passes onOutput to runner", async () => {
    const outputs: string[] = [];
    const mockRunner = async (_cmd: string[], opts: { onOutput?: (line: string) => void }) => {
      opts.onOutput?.("progress");
    };

    await uploadToR2("/tmp/files", "job-789", mockRunner as never, (line) => {
      outputs.push(line);
    });

    expect(outputs).toEqual(["progress"]);
  });
});

describe("r2WebseedUrl", () => {
  test("returns correct public URL", () => {
    expect(r2WebseedUrl("job-789")).toBe("https://upload.debridmediamanager.com/job-789");
  });

  test("handles nested paths", () => {
    expect(r2WebseedUrl("jobs/abc/files")).toBe(
      "https://upload.debridmediamanager.com/jobs/abc/files",
    );
  });
});
