import { config } from "./config";
import { runCommand } from "./utils/command";

type CommandRunner = typeof runCommand;

export async function uploadToR2(
  localPath: string,
  remotePath: string,
  runner: CommandRunner = runCommand,
  onOutput?: (line: string) => void,
): Promise<string> {
  if (config.r2MountPath) {
    const dest = `${config.r2MountPath}/${remotePath}`;
    await runner(["cp", "-r", localPath, dest], { onOutput });
  } else {
    const dest = `r2:${config.r2Bucket}/${remotePath}`;
    await runner(["rclone", "copy", "--s3-no-check-bucket", localPath, dest], { onOutput });
  }
  return `${config.r2PublicUrl}/${remotePath}`;
}

export function r2WebseedUrl(remotePath: string): string {
  return `${config.r2PublicUrl}/${remotePath}`;
}
