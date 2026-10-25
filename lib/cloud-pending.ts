/** Private pending cloud data only. Never stores credentials or touches prototype keys. */
import { z } from "zod";
import { writeSnapshot, PersistenceConflict } from "./persistence";
export const PENDING_PREFIX = "form-cloud-pending-v1:";
export const pendingKey = (subject: string) =>
  PENDING_PREFIX + encodeURIComponent(subject);
const envelope = z
  .object({
    version: z.literal(1),
    subject: z.string().min(1).max(128),
    updatedAt: z.string().datetime(),
    recovery: z.unknown(),
  })
  .strict();
export interface PendingLease {
  read(): unknown | null;
  write(recovery: unknown): void;
  clear(): void;
  close(): void;
}
export interface PendingStore {
  /** null means another tab holds the account's write lock. */
  open(subject: string): Promise<PendingLease | null>;
}
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function lease(
  storage: StoragePort,
  subject: string,
  release: () => void,
): PendingLease {
  const key = pendingKey(subject);
  let closed = false;
  let expected: string | null = null;
  let observed = false;
  const guard = () => {
    if (closed) throw new Error("PENDING_LEASE_CLOSED");
  };
  return {
    read() {
      guard();
      const raw = storage.getItem(key);
      if (observed && raw !== expected) throw new PersistenceConflict();
      expected = raw;
      observed = true;
      if (raw === null) return null;
      if (raw.length > 2_000_000) throw new Error("PENDING_DATA_INVALID");
      const value = envelope.parse(JSON.parse(raw));
      if (value.subject !== subject) throw new Error("PENDING_OWNER_MISMATCH");
      return value.recovery;
    },
    write(recovery) {
      guard();
      const raw = JSON.stringify({
        version: 1,
        subject,
        updatedAt: new Date().toISOString(),
        recovery,
      });
      if (raw.length > 2_000_000) throw new Error("PENDING_DATA_TOO_LARGE");
      expected = writeSnapshot(
        storage,
        key,
        expected,
        JSON.parse(raw),
        (value) => envelope.parse(value),
      );
      // Do not claim durability if a storage shim silently discards/replaces the write.
      if (storage.getItem(key) !== raw) throw new Error("PENDING_WRITE_FAILED");
    },
    clear() {
      guard();
      if (storage.getItem(key) !== expected) throw new PersistenceConflict();
      storage.removeItem(key);
      if (storage.getItem(key) !== null)
        throw new Error("PENDING_CLEAR_FAILED");
      expected = null;
    },
    close() {
      if (!closed) {
        closed = true;
        release();
      }
    },
  };
}
export class BrowserPendingStore implements PendingStore {
  async open(subject: string): Promise<PendingLease | null> {
    if (!navigator.locks) throw new Error("PENDING_LOCKS_UNAVAILABLE");
    // Acquire before reading even this account's journal. Never enumerate other users' keys.
    return new Promise((resolve, reject) => {
      void navigator.locks
        .request(pendingKey(subject), { ifAvailable: true }, async (lock) => {
          if (!lock) {
            resolve(null);
            return;
          }
          await new Promise<void>((release) =>
            resolve(lease(window.localStorage, subject, release)),
          );
        })
        .catch(reject);
    });
  }
}
/** Test-only storage adapter; browser runtime always selects BrowserPendingStore. */
export class MemoryPendingStore implements PendingStore {
  readonly values = new Map<string, string>();
  private locks = new Set<string>();
  failWrites = false;
  async open(subject: string) {
    if (this.locks.has(subject)) return null;
    this.locks.add(subject);
    return lease(
      {
        getItem: (key) => this.values.get(key) ?? null,
        setItem: (key, value) => {
          if (this.failWrites) throw new Error("PENDING_WRITE_FAILED");
          this.values.set(key, value);
        },
        removeItem: (key) => {
          if (this.failWrites) throw new Error("PENDING_CLEAR_FAILED");
          this.values.delete(key);
        },
      },
      subject,
      () => this.locks.delete(subject),
    );
  }
}
export const defaultPendingStore = (): PendingStore =>
  typeof window === "undefined"
    ? new MemoryPendingStore()
    : new BrowserPendingStore();
