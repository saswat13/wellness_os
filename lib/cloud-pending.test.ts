import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPendingStore, pendingKey } from "./cloud-pending";

test("pending leases touch only the authenticated account key and preserve prototype/foreign data", async () => {
  const store = new MemoryPendingStore();
  store.values.set("form-tracker-v3", "original workout");
  store.values.set("form-nutrition-v1", "original nutrition");
  store.values.set(pendingKey("B"), "private B");
  const a = (await store.open("A"))!;
  assert.equal(a.read(), null);
  a.write({ notes: "private A" });
  assert.equal(store.values.get("form-tracker-v3"), "original workout");
  assert.equal(store.values.get("form-nutrition-v1"), "original nutrition");
  assert.equal(store.values.get(pendingKey("B")), "private B");
  a.clear();
  assert.equal(store.values.get(pendingKey("B")), "private B");
  a.close();
  assert.throws(() => a.write({}), /LEASE_CLOSED/);
});

test("external changes cannot be overwritten, cleared or adopted by a stale journal lease", async () => {
  const store = new MemoryPendingStore();
  const a = (await store.open("A"))!;
  a.read();
  a.write({ notes: "A" });
  store.values.set(pendingKey("A"), "newer external data");
  assert.throws(() => a.write({ notes: "stale overwrite" }), /another tab/);
  assert.throws(() => a.clear(), /another tab/);
  assert.throws(() => a.read(), /another tab/);
  assert.equal(store.values.get(pendingKey("A")), "newer external data");
  a.close();
});

test("oversized or failed journal writes preserve the last complete recovery record", async () => {
  const store = new MemoryPendingStore();
  const a = (await store.open("A"))!;
  a.read();
  a.write({ notes: "retained" });
  const original = store.values.get(pendingKey("A"));
  assert.throws(() => a.write({ notes: "x".repeat(2_000_001) }), /TOO_LARGE/);
  store.failWrites = true;
  assert.throws(() => a.write({ notes: "rejected" }), /WRITE_FAILED/);
  assert.throws(() => a.clear(), /CLEAR_FAILED/);
  assert.equal(store.values.get(pendingKey("A")), original);
  a.close();
});

test("legacy journals remain readable and migrate only on an explicit successful write", async () => {
  const store = new MemoryPendingStore();
  const legacy = JSON.stringify({
    version: 1,
    subject: "A",
    updatedAt: "2026-10-25T00:00:00.000Z",
    recovery: { notes: "legacy private edits", key: "original-key" },
  });
  store.values.set(pendingKey("A"), legacy);
  const a = (await store.open("A"))!;
  assert.deepEqual(a.read(), {
    notes: "legacy private edits",
    key: "original-key",
  });
  assert.equal(store.values.get(pendingKey("A")), legacy);
  a.write(a.read());
  assert.equal(JSON.parse(store.values.get(pendingKey("A"))!).version, 2);
  assert.deepEqual(a.read(), {
    notes: "legacy private edits",
    key: "original-key",
  });
  a.close();
});

test("an unconfirmed discarded storage write can be retried without adopting a false checkpoint", async () => {
  const store = new MemoryPendingStore();
  const a = (await store.open("A"))!;
  a.read();
  a.write({ notes: "last durable edits" });
  const before = store.values.get(pendingKey("A"));
  store.dropWrites = true;
  assert.throws(() => a.write({ notes: "new edits" }), /WRITE_FAILED/);
  assert.equal(store.values.get(pendingKey("A")), before);
  store.dropWrites = false;
  a.write({ notes: "new edits" });
  assert.deepEqual(a.read(), { notes: "new edits" });
  a.close();
});
