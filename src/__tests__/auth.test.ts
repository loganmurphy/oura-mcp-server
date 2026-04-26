import { describe, it, expect, vi } from "vitest";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { defaultHandler } from "../index";
import { escapeHtml } from "../ui";
import type { Env } from "../index";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} };
}

const FAKE_OAUTH_REQ = {
  clientId: "test-client",
  redirectUri: "http://localhost:4066/oauth/callback",
  scope: "read",
  state: "test-state",
};

function makeEnv(overrides?: Partial<OAuthHelpers>): Env {
  return {
    OURA_API_TOKEN: "test-token",
    DB: {} as D1Database,
    OAUTH_KV: {} as KVNamespace,
    MCP_AUTH_PASSWORD: "correct-password",
    RATE_LIMITER: { limit: async () => ({ success: true }) } as Env["RATE_LIMITER"],
    OAUTH_PROVIDER: {
      parseAuthRequest: vi.fn().mockResolvedValue(FAKE_OAUTH_REQ),
      completeAuthorization: vi.fn().mockResolvedValue({
        redirectTo: "http://localhost:4066/oauth/callback?code=abc&state=test-state",
      }),
      ...overrides,
    } as unknown as OAuthHelpers,
  };
}

function formBody(fields: Record<string, string>): BodyInit {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

// ── escapeHtml ────────────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  it("escapes &, \", <, >", () => {
    expect(escapeHtml('a & b "c" <d>')).toBe("a &amp; b &quot;c&quot; &lt;d&gt;");
  });
  it("leaves plain strings unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

// ── defaultHandler routing ────────────────────────────────────────────────────

describe("defaultHandler — OPTIONS", () => {
  it("returns 204 with CORS headers", async () => {
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", { method: "OPTIONS" }),
      makeEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("defaultHandler — GET /authorize", () => {
  it("returns 400 when parseAuthRequest throws", async () => {
    const env = makeEnv({
      parseAuthRequest: vi.fn().mockRejectedValue(new Error("bad request")),
    });
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize?client_id=bad"),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(400);
  });

  it("returns login page HTML on valid OAuth request", async () => {
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize?client_id=test&response_type=code"),
      makeEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Oura MCP");
  });
});

describe("defaultHandler — POST /authorize", () => {
  it("returns 429 when rate limited", async () => {
    const env = makeEnv();
    env.RATE_LIMITER = { limit: async () => ({ success: false }) } as Env["RATE_LIMITER"];
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", { method: "POST", body: formBody({}) }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("returns 400 when body cannot be parsed as form data", async () => {
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not-form-data",
      }),
      makeEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid form submission");
  });

  it("returns 400 when oauth_params is missing", async () => {
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", {
        method: "POST",
        body: formBody({ password: "correct-password" }),
      }),
      makeEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when parseAuthRequest throws on reconstruction", async () => {
    const env = makeEnv({
      parseAuthRequest: vi.fn().mockRejectedValue(new Error("invalid")),
    });
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", {
        method: "POST",
        body: formBody({ password: "correct-password", oauth_params: "?client_id=bad" }),
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 401 with login page on wrong password", async () => {
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", {
        method: "POST",
        body: formBody({ password: "wrong", oauth_params: "?client_id=test" }),
      }),
      makeEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("Incorrect password");
  });

  it("returns 200 with success page on correct password", async () => {
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", {
        method: "POST",
        body: formBody({ password: "correct-password", oauth_params: "?client_id=test" }),
      }),
      makeEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Connected to Oura");
    expect(body).toContain("iframe");
  });

  it("returns 405 for unsupported method on /authorize", async () => {
    const res = await defaultHandler.fetch(
      new Request("http://localhost/authorize", { method: "DELETE" }),
      makeEnv(),
      makeCtx(),
    );
    expect(res.status).toBe(405);
  });
});
