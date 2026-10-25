import test from "node:test";
import assert from "node:assert/strict";
import { CloudClient } from "./cloud-client";

const session = (subject: string) =>
  Response.json({
    subject,
    csrfToken: "csrf-" + subject,
    expiresAt: "2026-10-25T12:00:00Z",
  });

test("cloud account changes clear private cache without reading prototype storage", async () => {
  let subject = "user-A";
  const client = new CloudClient(async (input) =>
    input === "/auth/session"
      ? session(subject)
      : Response.json(
          { private: subject },
          { headers: { "X-Form-Subject": subject } },
        ),
  );
  await client.request("/v1/me");
  assert.deepEqual(client.cached("/v1/me"), { private: "user-A" });
  subject = "user-B";
  await assert.rejects(client.request("/v1/me"), /ACCOUNT_CHANGED/);
  assert.equal(client.cached("/v1/me"), undefined);
  await client.refreshSession();
  assert.deepEqual(await client.request("/v1/me"), { private: "user-B" });
});

test("in-flight previous-account responses cannot repopulate cleared state", async () => {
  let resolve!: (value: Response) => void;
  const client = new CloudClient(async (input) =>
    input === "/auth/session"
      ? session("user-A")
      : new Promise<Response>((done) => {
          resolve = done;
        }),
  );
  await client.refreshSession();
  const request = client.request("/v1/me");
  client.clear();
  resolve(
    Response.json(
      { private: "user-A" },
      { headers: { "X-Form-Subject": "user-A" } },
    ),
  );
  await assert.rejects(request, /ACCOUNT_CHANGED/);
  assert.equal(client.cached("/v1/me"), undefined);
});

test("cloud mutations use cookie and CSRF, omit caller identity and retain conflict errors", async () => {
  let recorded: RequestInit | undefined;
  const client = new CloudClient(async (input, options) => {
    if (input === "/auth/session") return session("user-A");
    recorded = options;
    return Response.json(
      { error: { code: "REVISION_CONFLICT" } },
      { status: 412, headers: { "X-Form-Subject": "user-A" } },
    );
  });
  await assert.rejects(
    client.request("/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: "forged",
        "X-Owner-Id": "user-B",
        "If-Match": '"1"',
      },
    }),
    /API_412/,
  );
  const headers = new Headers(recorded?.headers);
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("x-owner-id"), null);
  assert.equal(headers.get("x-csrf-token"), "csrf-user-A");
  assert.equal(recorded?.credentials, "same-origin");
  assert.equal(recorded?.cache, "no-store");
});

test("default browser transport does not bind native fetch to the client object", async () => {
  const original = globalThis.fetch;
  const receivers: unknown[] = [];
  globalThis.fetch = async function (this: unknown) {
    receivers.push(this);
    return session("user-A");
  };
  try {
    const client = new CloudClient();
    await client.refreshSession();
    assert.ok(
      receivers.every((receiver) => !(receiver instanceof CloudClient)),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("unbound gateway errors preserve retry state but unbound successful data is rejected", async () => {
  let status = 503;
  const client = new CloudClient(async (input) =>
    input === "/auth/session"
      ? session("user-A")
      : Response.json({ message: "Service Unavailable" }, { status }),
  );
  await assert.rejects(
    client.request("/v1/nutrition/foods"),
    /API_503: REQUEST_FAILED \(GET \/v1\/nutrition\/foods\)/,
  );
  assert.equal(client.subject, "user-A");
  assert.equal(client.cached("/v1/nutrition/foods"), undefined);
  status = 200;
  await assert.rejects(client.request("/v1/me"), /ACCOUNT_CHANGED/);
  assert.equal(client.subject, null);
  assert.equal(client.cached("/v1/me"), undefined);
});

test("session discovery errors expose only the safe HTTP status and route", async () => {
  const client = new CloudClient(async () =>
    Response.json({ error: { code: "SESSION_UNAVAILABLE" } }, { status: 503 }),
  );
  await assert.rejects(client.refreshSession(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /API_503: SESSION_UNAVAILABLE \(GET \/auth\/session\)/);
    return true;
  });
});
