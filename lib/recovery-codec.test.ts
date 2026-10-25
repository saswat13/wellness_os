import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { packRecovery, unpackRecovery } from "./recovery-codec";
import { MemoryPendingStore, pendingKey } from "./cloud-pending";

test("a full launch catalog recovery round-trips below the unchanged journal limit", async () => {
  const catalog = JSON.parse(
    readFileSync(
      new URL("../backend/catalog/launch-v1/catalog.json", import.meta.url),
      "utf8",
    ),
  );
  const recovery = {
    baseline: catalog,
    projected: catalog,
    inFlight: catalog,
    pending: catalog,
    receipts: [["mutation-fingerprint", "original-idempotency-key"]],
    sides: [
      { side: "L", kg: 17.5, reps: 8, done: true },
      { side: "R", kg: 12.5, reps: 6, done: false },
    ],
  };
  assert.ok(JSON.stringify(recovery).length > 2_000_000);
  const store = new MemoryPendingStore();
  const lease = (await store.open("A"))!;
  lease.read();
  lease.write(recovery);
  assert.ok(store.values.get(pendingKey("A"))!.length < 2_000_000);
  assert.deepEqual(lease.read(), recovery);
  lease.close();
  const reopened = (await store.open("A"))!;
  assert.deepEqual(reopened.read(), recovery);
  reopened.close();
});

test("dictionary decoding is bounded and rejects corrupt references or duplicate keys", () => {
  for (const raw of [
    { strings: ["x"], root: ["s", 2] },
    { strings: ["x"], root: ["s", -1] },
    {
      strings: ["x"],
      root: [
        "o",
        [
          [0, null],
          [0, true],
        ],
      ],
    },
    { strings: ["x"], root: ["unknown", []] },
    {
      strings: ["x".repeat(1_000_000)],
      root: ["a", Array.from({ length: 17 }, () => ["s", 0])],
    },
  ])
    assert.throws(() => unpackRecovery(raw), /PENDING_DATA_INVALID/);
  const original = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"data","left":null,"right":false,"reps":0}',
  );
  const result = unpackRecovery(packRecovery(original));
  assert.deepEqual(result, original);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
