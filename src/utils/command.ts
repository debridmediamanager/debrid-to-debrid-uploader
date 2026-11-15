type CommandOptions = {
  timeoutMs?: number;
  onOutput?: (line: string) => void;
  signal?: AbortSignal;
};

export async function runCommand(cmd: string[], opts: CommandOptions = {}): Promise<void> {
  const { timeoutMs = 60 * 60 * 1000, onOutput, signal } = opts;
  const proc = Bun.spawn(cmd, {
    stdout: onOutput ? "pipe" : "ignore",
    stderr: onOutput ? "pipe" : "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);

  if (signal) {
    if (signal.aborted) {
      proc.kill();
    } else {
      signal.addEventListener("abort", () => proc.kill(), { once: true });
    }
  }

  let stderrText = "";

  async function streamReader(
    stream: ReadableStream<Uint8Array> | null | undefined,
    emit: (line: string) => void,
  ) {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        buf += chunk;
        const lines = buf.split(/\r|\n/);
        buf = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) emit(line.trim());
        }
      }
      if (buf.trim()) emit(buf.trim());
    } catch {}
  }

  if (onOutput) {
    await Promise.all([streamReader(proc.stdout, onOutput), streamReader(proc.stderr, onOutput)]);
  }

  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (exitCode !== 0) {
    if (!onOutput && proc.stderr) {
      stderrText = await new Response(proc.stderr).text();
    }
    throw new Error(`${cmd[0]} exited ${exitCode}: ${stderrText.slice(0, 500)}`);
  }
}
