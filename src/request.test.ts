import { describe, expect, test } from "bun:test";
import { requestIp } from "./request";

const req = (headers: Record<string, string> = {}) => ({
  header(name: string) {
    return headers[name];
  },
});

describe("requestIp", () => {
  test("prefers forwarded headers over runtime bindings", () => {
    expect(requestIp(req({ "x-forwarded-for": "203.0.113.1" }), { ip: "127.0.0.1" })).toBe(
      "203.0.113.1",
    );
    expect(requestIp(req({ "x-real-ip": "203.0.113.2" }), { ip: "127.0.0.1" })).toBe("203.0.113.2");
  });

  test("falls back to bindings and unknown", () => {
    expect(requestIp(req(), { ip: "127.0.0.1" })).toBe("127.0.0.1");
    expect(requestIp(req())).toBe("unknown");
  });
});
