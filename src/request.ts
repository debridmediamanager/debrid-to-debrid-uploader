type HeaderReader = {
  header(name: string): string | undefined;
};

type RequestEnv = {
  ip?: string;
};

export function requestIp(req: HeaderReader, env?: RequestEnv): string {
  return req.header("x-forwarded-for") || req.header("x-real-ip") || env?.ip || "unknown";
}
