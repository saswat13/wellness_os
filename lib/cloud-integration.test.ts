import test from "node:test";
import assert from "node:assert/strict";
import { CloudClient } from "./cloud-client";
import { FormApi } from "./form-api";
import { CloudController } from "./cloud-controller";
import type { Schemas } from "./api-v1.generated";
import { parseStore, saveTemplate } from "./tracker";
import { MemoryPendingStore, pendingKey } from "./cloud-pending";
import { today } from "./nutrition";

function fixture(
  completedHistory = false,
  pendingStore = new MemoryPendingStore(),
  failPath?: string,
) {
  let subject = "pilot-A",
    lost = false,
    hold: ((response: Response) => void) | null = null;
  let pause = false;
  let expired = false;
  let committed: (() => void) | null = null;
  const writes: Array<{
    key: string | null;
    revision: string | null;
    body: Record<string, unknown>;
    subject: string;
  }> = [];
  const receipts = new Map<string, unknown>();
  const sessions = new Map<string, Schemas["WorkoutResource"]>();
  const record = (ownerSub = subject) => ({
    ownerSub,
    revision: 1,
    createdAt: "2026-10-17T12:00:00Z",
    updatedAt: "2026-10-17T12:00:00Z",
  });
  const current = () => {
    if (!sessions.has(subject))
      sessions.set(subject, {
        ...record(),
        id: subject + "-workout",
        name: "Cloud workout",
        trainingType: "hypertrophy",
        templateId: null,
        exercises: [],
        startedAt: "2026-10-17T12:00:00Z",
        status: "active",
        notes: "",
        unit: "kg",
      });
    return sessions.get(subject)!;
  };
  const fetcher: typeof fetch = async (input, options) => {
    const path = String(input),
      url = new URL(path, "https://form.test");
    if (path === "/auth/session")
      return expired
        ? Response.json({}, { status: 401 })
        : Response.json({
            subject,
            csrfToken: "csrf-" + subject,
            expiresAt: "2026-10-25T12:00:00Z",
          });
    if (path === "/auth/logout") return Response.json({ logoutUrl: "" });
    if (expired) return Response.json({}, { status: 401 });
    const reply = (payload: unknown, status = 200) =>
      Response.json(payload, {
        status,
        headers: { "X-Form-Subject": subject },
      });
    const entity = (data: unknown) =>
      reply({ data, meta: { requestId: "fixture" } });
    const page = (items: unknown[]) =>
      reply({ items, nextCursor: null, meta: { requestId: "fixture" } });
    if (failPath && url.pathname === failPath)
      return reply({ error: { code: "SERVICE_UNAVAILABLE" } }, 503);
    if (options?.method === "PUT") {
      const headers = new Headers(options.headers),
        body = JSON.parse(String(options.body));
      const key = headers.get("Idempotency-Key")!;
      writes.push({ key, revision: headers.get("If-Match"), body, subject });
      if (receipts.has(key)) return entity(receipts.get(key));
      if (headers.get("If-Match") !== `"${current().revision}"`)
        return reply({ error: { code: "REVISION_CONFLICT" } }, 412);
      const updated = {
        ...current(),
        ...body,
        revision: current().revision + 1,
      };
      sessions.set(subject, updated);
      receipts.set(key, updated);
      committed?.();
      if (lost) {
        lost = false;
        return Response.json(
          { error: { code: "SERVICE_UNAVAILABLE" } },
          { status: 503 },
        );
      }
      if (pause)
        return new Promise<Response>((resolve) => {
          hold = resolve;
        });
      return entity(updated);
    }
    if (url.pathname.endsWith("/sessions/active")) return page([current()]);
    if (url.pathname.endsWith("/templates"))
      return page([
        {
          ...record(),
          id: "existing-template",
          name: "Existing private plan",
          trainingType: "hypertrophy",
          exercises: [],
        },
      ]);
    if (url.pathname.endsWith("/sessions"))
      return page(
        completedHistory
          ? [
              {
                ...current(),
                status: "completed",
                completedAt: "2026-10-17T13:00:00Z",
              },
            ]
          : [],
      );
    if (url.pathname.endsWith("/me"))
      return entity({
        ...record(),
        id: "profile",
        name: subject,
        unit: "kg",
        timeZone: "America/Los_Angeles",
        favoriteFoodIds: [],
      });
    if (url.pathname.endsWith("/goals"))
      return entity({
        ...record(),
        id: "current",
        version: 1,
        effectiveFrom: "2026-01-01",
        calories: 2400,
        protein: 160,
        carbs: 290,
        fat: 67,
      });
    if (url.pathname.endsWith("/diary"))
      return entity({
        date: url.searchParams.get("date"),
        entries:
          url.searchParams.get("date") === today()
            ? [
                {
                  ...record(),
                  id: subject + "-existing-diary",
                  date: today(),
                  meal: "Lunch",
                  sourceType: "food",
                  sourceId: "historical-food",
                  sourceRevision: 1,
                  grams: 100,
                  snapshot: {
                    name: "Historical food",
                    preparation: "cooked",
                    per100g: { calories: 100, protein: 1, carbs: 20, fat: 1 },
                  },
                },
              ]
            : [],
        totals: { calories: 0, protein: 0, carbs: 0, fat: 0 },
        goals: null,
        dayRevision: 0,
      });
    return page([]);
  };
  const createController = () =>
    new CloudController(new FormApi(new CloudClient(fetcher)), pendingStore);
  const controller = createController();
  return {
    controller,
    writes,
    sessions,
    pendingStore,
    afterCommit: (fn: () => void) => {
      committed = fn;
    },
    createController,
    expire: () => {
      expired = true;
    },
    signInAs: (who: "pilot-A" | "pilot-B") => {
      expired = false;
      subject = who;
    },
    loseNext: () => {
      lost = true;
    },
    pause: () => {
      pause = true;
    },
    switchAccount: () => {
      subject = "pilot-B";
    },
    release: () => {
      hold?.(
        Response.json(
          { data: current(), meta: { requestId: "late" } },
          { headers: { "X-Form-Subject": "pilot-A" } },
        ),
      );
    },
  };
}

test("discovery reports the failed API route without exposing query parameters", async () => {
  const f = fixture(
    false,
    new MemoryPendingStore(),
    "/api/v1/nutrition/foods",
  );
  await f.controller.discover();
  const state = f.controller.snapshot();
  assert.equal(state.phase, "unavailable");
  assert.match(
    state.message,
    /GET \/v1\/nutrition\/foods returned HTTP 503 \(SERVICE_UNAVAILABLE\)/,
  );
  assert.doesNotMatch(state.message, /cursor|csrf|cookie|token/i);
  assert.match(state.message, /pending data is preserved/i);
  f.controller.dispose();
});

test("cloud save retains the exact idempotency key/precondition after a lost response", async () => {
  const f = fixture();
  await f.controller.discover();
  assert.equal(f.controller.snapshot().phase, "ready");
  f.loseNext();
  f.controller.setTracker((s) => ({
    ...s,
    session: { ...s.session, notes: "Saved once" },
  }));
  await f.controller.flush();
  assert.equal(f.controller.snapshot().status, "error");
  assert.equal(
    f.controller.snapshot().data?.tracker.session.notes,
    "Saved once",
  );
  await f.controller.retry();
  assert.equal(f.controller.snapshot().status, "saved");
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0].key, f.writes[1].key);
  assert.equal(f.writes[0].revision, f.writes[1].revision);
  assert.equal(f.sessions.get("pilot-A")?.revision, 2);
  assert.ok(!("ownerSub" in f.writes[0].body));
  f.controller.dispose();
});

test("completed generations do not hide a reopened active workout during discovery", async () => {
  const f = fixture(true);
  await f.controller.discover();
  const state = f.controller.snapshot();
  assert.equal(state.phase, "ready");
  assert.equal(state.data?.tracker.session.finished, false);
  assert.equal(f.controller.activeWorkouts().length, 1);
  assert.equal(state.data?.tracker.history[0].finished, true);
  assert.equal(
    state.data?.tracker.history[0].id,
    state.data?.tracker.session.id,
  );
  f.controller.dispose();
});

test("account switching hides previous private state before another account loads", async () => {
  const f = fixture();
  await f.controller.discover();
  f.controller.setTracker((s) => ({
    ...s,
    session: { ...s.session, notes: "Private A" },
  }));
  await f.controller.flush();
  f.switchAccount();
  await f.controller.refreshAuthentication();
  assert.equal(f.controller.snapshot().data, null);
  await f.controller.discover();
  assert.equal(f.controller.snapshot().subject, "pilot-B");
  assert.equal(f.controller.snapshot().data?.tracker.session.notes, "");
  assert.equal(f.controller.snapshot().data?.tracker.history.length, 0);
  f.controller.dispose();
});

test("cloud template editing validates its account while local persistence keeps its fixed-owner guard", async () => {
  const f = fixture();
  await f.controller.discover();
  const store = f.controller.snapshot().data!.tracker;
  const next = saveTemplate(store, {
    id: "cloud-template",
    ownerId: "pilot-A",
    name: "Cloud plan",
    trainingType: "hypertrophy",
    visibility: "private",
    exercises: [],
    createdAt: "2026-10-18T12:00:00Z",
    updatedAt: "2026-10-18T12:00:00Z",
  });
  assert.equal(
    next.templates.find((t) => t.id === "cloud-template")?.name,
    "Cloud plan",
  );
  assert.throws(() => parseStore(next), /Unknown local owner/);
  assert.throws(
    () => saveTemplate(store, { ...next.templates[0], ownerId: "pilot-B" }),
    /Only your templates/,
  );
  assert.equal(store.templates.length, 1);
  f.controller.dispose();
});

test("logout clears a pending cloud save and a delayed response cannot repopulate it", async () => {
  const f = fixture();
  await f.controller.discover();
  f.pause();
  f.controller.setTracker((s) => ({
    ...s,
    session: { ...s.session, notes: "In flight" },
  }));
  const pending = f.controller.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.controller.logout();
  assert.equal(f.controller.snapshot().data, null);
  f.release();
  await pending;
  assert.equal(f.controller.snapshot().data, null);
  f.controller.dispose();
});

test("typed API paginates all pages and sends schema-scoped mutation metadata", async () => {
  const requests: Array<{ path: string; options?: RequestInit }> = [];
  const client = new FormApi(
    new CloudClient(async (input, options) => {
      const path = String(input);
      requests.push({ path, options });
      if (path === "/auth/session")
        return Response.json({
          subject: "A",
          csrfToken: "csrf",
          expiresAt: "2026-10-25T00:00:00Z",
        });
      return Response.json(
        path.includes("cursor=")
          ? {
              items: [{ id: "second" }],
              nextCursor: null,
              meta: { requestId: "two" },
            }
          : {
              items: [{ id: "first" }],
              nextCursor: "signed.cursor",
              meta: { requestId: "one" },
            },
        { headers: { "X-Form-Subject": "A" } },
      );
    }),
  );
  const rows = await client.all("GET /v1/workouts/exercises");
  assert.deepEqual(
    rows.map((r) => r.id),
    ["first", "second"],
  );
  assert.ok(requests.some((r) => r.path.includes("cursor=signed.cursor")));
});

test("pending workout and nutrition targets survive controller recreation before debounce", async () => {
  const f = fixture();
  await f.controller.discover();
  f.controller.setTracker((s) => ({
    ...s,
    session: { ...s.session, notes: "Recover workout" },
  }));
  f.controller.setNutrition((s) => ({
    ...s,
    user: { ...s.user, name: "Recover nutrition" },
  }));
  const raw = f.pendingStore.values.get(pendingKey("pilot-A"))!;
  assert.ok(
    raw.includes("Recover workout") && raw.includes("Recover nutrition"),
  );
  assert.ok(!raw.includes("csrfToken") && !raw.includes("csrf-pilot"));
  f.controller.dispose();
  const next = f.createController();
  await next.discover();
  assert.equal(next.snapshot().status, "pending");
  assert.equal(next.snapshot().data?.tracker.session.notes, "Recover workout");
  assert.equal(next.snapshot().data?.nutrition.user.name, "Recover nutrition");
  assert.equal(f.writes.length, 0, "recovery requires explicit retry");
  await next.loadDay("2026-10-18");
  await next.flush();
  assert.equal(
    f.writes.length,
    0,
    "navigation/background reads cannot resume a recovered batch",
  );
  assert.equal(next.snapshot().status, "pending");
  next.dispose();
});

test("refresh after successful but unacknowledged mutation replays original key/revision once", async () => {
  const f = fixture();
  await f.controller.discover();
  f.loseNext();
  f.controller.setTracker((s) => ({
    ...s,
    session: { ...s.session, notes: "Committed once" },
  }));
  await f.controller.flush();
  assert.equal(f.controller.snapshot().status, "error");
  const original = f.writes[0];
  f.controller.dispose();
  const next = f.createController();
  await next.discover();
  assert.equal(next.snapshot().status, "pending");
  await next.retry();
  assert.equal(next.snapshot().status, "saved");
  assert.equal(f.writes[1].key, original.key);
  assert.equal(f.writes[1].revision, original.revision);
  assert.deepEqual(f.writes[1].body, original.body);
  assert.equal(f.sessions.get("pilot-A")?.revision, 2);
  assert.equal(f.pendingStore.values.has(pendingKey("pilot-A")), false);
  next.dispose();
});

test("newer edits queued during a lost response retain ordered batches after recovery", async () => {
  const f = fixture();
  await f.controller.discover();
  f.pause();
  f.controller.setTracker((s) => ({
    ...s,
    session: { ...s.session, notes: "First" },
  }));
  const running = f.controller.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.controller.setTracker((s) => ({
    ...s,
    session: { ...s.session, notes: "Second" },
  }));
  f.controller.dispose();
  f.release();
  await running;
  const next = f.createController();
  await next.discover();
  assert.equal(next.snapshot().data?.tracker.session.notes, "Second");
  // First request has a durable receipt, so it replays without pausing; only the new request is held.
  const retry = next.retry();
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.release();
  await retry;
  assert.equal(f.writes[0].key, f.writes[1].key);
  assert.equal(f.sessions.get("pilot-A")?.notes, "Second");
  assert.equal(f.sessions.get("pilot-A")?.revision, 3);
  assert.equal(next.snapshot().status, "saved");
  next.dispose();
});

test("recovery preserves stale preconditions and conflicts rather than rebasing", async () => {
  const f = fixture();
  await f.controller.discover();
  f.controller.setTracker((s) => ({
    ...s,
    session: { ...s.session, notes: "Pending old revision" },
  }));
  f.controller.dispose();
  f.sessions.set("pilot-A", {
    ...f.sessions.get("pilot-A")!,
    revision: 2,
    notes: "Another device",
  });
  const next = f.createController();
  await next.discover();
  await next.retry();
  assert.equal(next.snapshot().status, "conflict");
  assert.equal(f.writes[0].revision, '"1"');
  assert.equal(f.sessions.get("pilot-A")?.notes, "Another device");
  assert.ok(f.pendingStore.values.has(pendingKey("pilot-A")));
  await next.retry();
  assert.equal(
    f.writes.length,
    1,
    "conflicts cannot force retry over newer data",
  );
  await next.reload();
  assert.equal(next.snapshot().data?.tracker.session.notes, "Another device");
  assert.equal(f.pendingStore.values.has(pendingKey("pilot-A")), false);
  next.dispose();
});

test("logout and expiry hide but retain A's pending records; B cannot display or upload them", async () => {
  const f = fixture();
  await f.controller.discover();
  f.controller.setTracker((s) => ({
    ...s,
    session: { ...s.session, notes: "Private A draft" },
  }));
  await f.controller.logout();
  assert.equal(f.controller.snapshot().data, null);
  const before = f.pendingStore.values.get(pendingKey("pilot-A"));
  f.controller.dispose();
  f.signInAs("pilot-B");
  const b = f.createController();
  await b.discover();
  assert.equal(b.snapshot().data?.tracker.session.notes, "");
  await b.flush();
  assert.equal(f.writes.length, 0);
  assert.equal(f.pendingStore.values.get(pendingKey("pilot-A")), before);
  b.dispose();
  f.signInAs("pilot-A");
  const a = f.createController();
  await a.discover();
  assert.equal(a.snapshot().data?.tracker.session.notes, "Private A draft");
  f.expire();
  await a.retry();
  assert.equal(a.snapshot().data, null);
  assert.ok(f.pendingStore.values.has(pendingKey("pilot-A")));
  a.dispose();
});

test("storage failure blocks network writes and explicit retry recovers after storage is available", async () => {
  const f = fixture();
  await f.controller.discover();
  f.pendingStore.failWrites = true;
  f.controller.setTracker((s) => ({
    ...s,
    session: { ...s.session, notes: "Not yet durable" },
  }));
  assert.equal(f.controller.snapshot().status, "error");
  assert.equal(f.controller.snapshot().durable, false);
  await f.controller.flush();
  assert.equal(f.writes.length, 0);
  f.pendingStore.failWrites = false;
  await f.controller.retry();
  assert.equal(f.controller.snapshot().status, "saved");
  assert.equal(f.controller.snapshot().durable, true);
  assert.equal(f.writes.length, 1);
  f.controller.dispose();
});

test("corrupt and foreign journals are preserved and never uploaded", async () => {
  const f = fixture();
  const key = pendingKey("pilot-A");
  f.pendingStore.values.set(key, '{"corrupt":true}');
  await f.controller.discover();
  assert.equal(f.controller.snapshot().phase, "unavailable");
  assert.equal(f.controller.snapshot().data, null);
  assert.equal(f.pendingStore.values.get(key), '{"corrupt":true}');
  assert.equal(f.writes.length, 0);
  f.controller.dispose();
  f.pendingStore.values.set(
    key,
    JSON.stringify({
      version: 1,
      subject: "pilot-B",
      updatedAt: new Date().toISOString(),
      recovery: {},
    }),
  );
  const next = f.createController();
  await next.discover();
  assert.equal(next.snapshot().phase, "unavailable");
  assert.equal(next.snapshot().data, null);
  assert.equal(f.writes.length, 0);
  next.dispose();
});

test("only one tab can write an account journal and other tabs cannot erase it", async () => {
  const f = fixture();
  await f.controller.discover();
  f.controller.setTracker((s) => ({
    ...s,
    session: { ...s.session, notes: "Writer's pending" },
  }));
  const raw = f.pendingStore.values.get(pendingKey("pilot-A"));
  const other = f.createController();
  await other.discover();
  assert.equal(other.snapshot().locked, true);
  other.setTracker((s) => ({
    ...s,
    session: { ...s.session, notes: "Foreign tab" },
  }));
  assert.equal(f.pendingStore.values.get(pendingKey("pilot-A")), raw);
  f.controller.dispose();
  await other.discover();
  assert.equal(
    other.snapshot().data?.tracker.session.notes,
    "Writer's pending",
  );
  assert.equal(other.snapshot().status, "pending");
  other.dispose();
});

test("failure to clear an acknowledged batch retains replay identity across restart", async () => {
  const f = fixture();
  await f.controller.discover();
  f.afterCommit(() => {
    f.pendingStore.failWrites = true;
  });
  f.controller.setTracker((s) => ({
    ...s,
    session: { ...s.session, notes: "Acknowledged before quota failure" },
  }));
  await f.controller.flush();
  assert.equal(f.controller.snapshot().status, "error");
  assert.ok(f.pendingStore.values.has(pendingKey("pilot-A")));
  f.controller.dispose();
  f.pendingStore.failWrites = false;
  const next = f.createController();
  await next.discover();
  await next.retry();
  assert.equal(next.snapshot().status, "saved");
  assert.equal(f.writes[0].key, f.writes[1].key);
  assert.equal(f.sessions.get("pilot-A")?.revision, 2);
  next.dispose();
});

test("recovery retains existing diary revisions and never recreates unrelated historical entries", async () => {
  const f = fixture();
  await f.controller.discover();
  f.controller.setNutrition((s) => ({ ...s }));
  f.controller.dispose();
  const next = f.createController();
  await next.discover();
  await next.retry();
  assert.equal(next.snapshot().status, "saved");
  assert.equal(
    next.snapshot().data?.nutrition.diary[0].id,
    "pilot-A-existing-diary",
  );
  assert.equal(
    next.snapshot().data?.nutrition.diary[0].snapshot.per100g.calories,
    100,
  );
  next.dispose();
});
