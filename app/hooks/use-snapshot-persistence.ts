"use client";
import {
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { PersistenceConflict, writeSnapshot } from "@/lib/persistence";

export function useSnapshotPersistence<T>(
  key: string,
  label: string,
  value: T,
  ready: boolean,
  blocked: boolean,
  snapshot: RefObject<string | null>,
  validate: (value: unknown) => T,
  setWarning: Dispatch<SetStateAction<string>>,
  setBlocked: Dispatch<SetStateAction<boolean>>,
) {
  const stopped = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    if (!ready || blocked) return;
    const conflict = () => {
      stopped.current = true;
      setBlocked(true);
      setWarning(
        `${label} changed in another tab. Saving from this tab is paused to protect newer records. Download unsaved data before loading the latest saved data.`,
      );
    };
    const onStorage = (event: StorageEvent) => {
      if (
        (event.key === key && event.newValue !== snapshot.current) ||
        event.key === null
      )
        conflict();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, label, ready, blocked, snapshot, setWarning, setBlocked]);

  useEffect(() => {
    if (!ready || blocked || stopped.current) return;
    const current = ++generation.current;
    let cancelled = false;
    const write = () => {
      if (cancelled || stopped.current || current !== generation.current)
        return;
      try {
        snapshot.current = writeSnapshot(
          localStorage,
          key,
          snapshot.current,
          value,
          validate,
        );
      } catch (error) {
        stopped.current = true;
        setBlocked(true);
        setWarning(
          error instanceof PersistenceConflict
            ? `${label} changed in another tab. Saving from this tab is paused to protect newer records. Download unsaved data before loading the latest saved data.`
            : `${label} could not be saved. Your last saved data is preserved. Keep this tab open and download unsaved data before reloading.`,
        );
      }
    };
    // Serialize cooperating tabs, and check the expected snapshot inside the lock.
    // Other browsers still get a best-effort optimistic check and storage events.
    const save = async () => {
      if (navigator.locks)
        await navigator.locks.request(`form-storage:${key}`, write);
      else write();
    };
    void save().catch(() => {
      stopped.current = true;
      setBlocked(true);
      setWarning(
        `${label} could not be saved. Keep this tab open and download unsaved data before reloading.`,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [
    key,
    label,
    value,
    ready,
    blocked,
    snapshot,
    validate,
    setWarning,
    setBlocked,
  ]);
}
