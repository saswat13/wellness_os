/** Optimistic guard used under a browser Web Lock when one is available. */
export class PersistenceConflict extends Error {
  constructor() {
    super("Saved data changed in another tab.");
  }
}
export type SnapshotStorage = Pick<Storage, "getItem" | "setItem">;
export function writeSnapshot<T>(
  storage: SnapshotStorage,
  key: string,
  expected: string | null,
  value: T,
  validate: (value: unknown) => T,
): string {
  const serialized = JSON.stringify(validate(value));
  const current = storage.getItem(key);
  if (current !== expected && current !== serialized)
    throw new PersistenceConflict();
  if (current !== serialized) storage.setItem(key, serialized);
  return serialized;
}
