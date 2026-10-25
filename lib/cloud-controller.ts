import type { Dispatch, SetStateAction } from "react";
import { FormApi, ApiError } from "./form-api";
import {
  CloudWorkspace,
  validateCloudData,
  type CloudData,
  type Day,
} from "./cloud-workspace";
import {
  defaultPendingStore,
  type PendingStore,
  type PendingLease,
} from "./cloud-pending";
import { z } from "zod";
import type { TrackerStore } from "./models";
import type { NutritionStore, Recipe } from "./nutrition";
export type CloudState = {
  phase: "loading" | "signed-out" | "ready" | "unavailable";
  data: CloudData | null;
  subject: string | null;
  status: "saved" | "pending" | "saving" | "error" | "conflict";
  message: string;
  locked: boolean;
  date: string | null;
  day: Day | null;
  historicalRecipe: Recipe | null;
  durable: boolean;
};
const initial: CloudState = {
  phase: "loading",
  data: null,
  subject: null,
  status: "saved",
  message: "",
  locked: true,
  date: null,
  day: null,
  historicalRecipe: null,
  durable: true,
};
type Batch = { tracker?: TrackerStore; nutrition?: NutritionStore };
function discoveryFailureMessage(
  stage: string,
  error: unknown,
): string {
  const detail =
    error instanceof ApiError && error.method && error.path
      ? `${error.method} ${error.path} returned HTTP ${error.status} (${error.code})`
      : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : null;
  return [
    detail
      ? `Cloud account loading failed: ${detail}.`
      : `Cloud account loading failed during ${stage}.`,
    "Existing pending data is preserved on this device. Retry session discovery.",
  ].join(" ");
}
/** Durable, account-scoped batches. Recovery/retries never rebase stale revisions silently. */
export class CloudController {
  private state: CloudState = initial;
  private subscribers = new Set<() => void>();
  private workspace: CloudWorkspace | null = null;
  private epoch = 0;
  private leases = 0;
  connect() {
    const lease = ++this.leases;
    this.api.transport.connectTabs();
    return () =>
      queueMicrotask(() => {
        if (this.leases === lease) this.dispose();
      });
  }
  private pending: Batch = {};
  private inFlight: Batch | null = null;
  private startPending = false;
  private recoveryPaused = false;
  private journal: PendingLease | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private deferredAction: (() => Promise<CloudData>) | null = null;
  private release: () => void;
  constructor(
    public readonly api = new FormApi(),
    private readonly pendingStore: PendingStore = defaultPendingStore(),
  ) {
    this.release = api.transport.onInvalidated(() =>
      this.invalidate("Session ended or account changed. Sign in to continue."),
    );
  }
  subscribe = (fn: () => void) => {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  };
  snapshot = () => this.state;
  private patch(value: Partial<CloudState>) {
    this.state = { ...this.state, ...value };
    for (const fn of this.subscribers) fn();
  }
  private check(epoch: number) {
    if (epoch !== this.epoch) throw new Error("ACCOUNT_CHANGED");
  }
  private invalidate(message: string) {
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.workspace?.dispose();
    this.workspace = null;
    this.pending = {};
    this.inFlight = null;
    this.startPending = false;
    this.recoveryPaused = false;
    this.journal?.close();
    this.journal = null;
    this.saving = null;
    this.deferredAction = null;
    this.state = { ...initial, phase: "signed-out", message };
    for (const fn of this.subscribers) fn();
  }
  dispose() {
    this.release();
    this.invalidate("");
    this.api.transport.dispose();
    this.subscribers.clear();
  }
  get unsaved() {
    return this.state.status !== "saved" || !!this.saving;
  }
  recoveryExport() {
    if (
      !this.state.subject ||
      this.api.transport.subject !== this.state.subject
    )
      return null;
    let journal: unknown = null;
    try {
      journal = this.journal?.read() ?? null;
    } catch {
      /* Keep the in-memory backup available if device storage fails. */
    }
    return {
      kind: "private-cloud-recovery",
      subject: this.state.subject,
      data: this.state.data,
      journal,
    };
  }
  async discover() {
    const epoch = ++this.epoch;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = {};
    this.inFlight = null;
    this.startPending = false;
    this.recoveryPaused = false;
    this.saving = null;
    this.deferredAction = null;
    this.workspace?.dispose();
    this.journal?.close();
    this.journal = null;
    this.patch({ ...initial });
    let stage = "session discovery";
    try {
      const identity = await this.api.transport.refreshSession();
      this.check(epoch);
      if (!identity) {
        this.patch({ phase: "signed-out", locked: true });
        return;
      }
      stage = "device recovery";
      const journal = await this.pendingStore.open(identity.subject);
      if (epoch !== this.epoch) {
        journal?.close();
        return;
      }
      this.journal = journal;
      const workspace = new CloudWorkspace(this.api, identity.subject, () =>
        this.persist(),
      );
      this.workspace = workspace;
      const recovered = journal?.read();
      if (recovered) {
        const data = this.restore(recovered, workspace);
        this.recoveryPaused = true;
        this.patch({
          phase: "ready",
          subject: identity.subject,
          status: "pending",
          locked: true,
          durable: true,
          data,
          message:
            "Recovered pending changes for this account from this device. Review them, then retry saving. Original revisions and request keys are preserved.",
        });
        return;
      }
      stage = "cloud record loading";
      const data = await workspace.load();
      this.check(epoch);
      this.patch({
        phase: "ready",
        data,
        subject: identity.subject,
        locked: !journal,
        status: "saved",
        message: journal
          ? ""
          : "Another tab is editing this account. Close it and retry session discovery here to enable saving. This tab is read-only.",
      });
    } catch (error) {
      if (epoch === this.epoch)
        this.patch({
          phase: "unavailable",
          message: discoveryFailureMessage(stage, error),
          locked: true,
          data: null,
        });
    }
  }
  async refreshAuthentication() {
    if (this.state.phase !== "ready") return;
    const epoch = this.epoch;
    try {
      await this.api.transport.refreshSession();
    } catch (error) {
      if (epoch === this.epoch) this.fail(error);
    }
  }
  setTracker: Dispatch<SetStateAction<TrackerStore>> = (update) => {
    const current = this.state.data;
    if (!current || this.state.locked) return;
    const tracker =
      typeof update === "function" ? update(current.tracker) : update;
    this.pending.tracker = tracker;
    const newSession =
      !this.workspace?.sessions.has(tracker.session.id) &&
      tracker.session !== current.tracker.session;
    this.patch({
      data: { ...current, tracker },
      status: "pending",
      locked: newSession,
    });
    if (!this.savePending()) return;
    this.schedule();
  };
  setNutrition: Dispatch<SetStateAction<NutritionStore>> = (update) => {
    const current = this.state.data;
    if (!current || this.state.locked) return;
    const nutrition =
      typeof update === "function" ? update(current.nutrition) : update;
    this.pending.nutrition = nutrition;
    this.patch({ data: { ...current, nutrition }, status: "pending" });
    if (!this.savePending()) return;
    this.schedule();
  };
  private compact(batch: Batch): Batch {
    return {
      ...batch,
      ...(batch.tracker ? { tracker: { ...batch.tracker, history: [] } } : {}),
    };
  }
  private persist() {
    const workspace = this.workspace;
    if (
      !workspace ||
      !this.journal ||
      this.api.transport.subject !== workspace.subject
    )
      throw new Error("ACCOUNT_CHANGED");
    try {
      if (
        !this.inFlight &&
        !this.pending.tracker &&
        !this.pending.nutrition &&
        !this.startPending
      ) {
        this.journal.clear();
        workspace.forgetReceipts();
      } else {
        for (const batch of [this.inFlight, this.pending])
          if (batch)
            validateCloudData(
              {
                tracker: batch.tracker ?? workspace.data.tracker,
                nutrition: batch.nutrition ?? workspace.data.nutrition,
              },
              workspace.subject,
            );
        const recovery = {
          baseline: workspace.checkpoint(),
          inFlight: this.inFlight ? this.compact(this.inFlight) : null,
          pending: this.compact(this.pending),
          startPending: this.startPending,
        };
        this.journal.write(recovery);
      }
      this.patch({ durable: true });
    } catch (error) {
      this.patch({ durable: false });
      throw new Error("PENDING_STORAGE_FAILED", { cause: error });
    }
  }
  private savePending() {
    try {
      this.persist();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }
  private restore(raw: unknown, workspace: CloudWorkspace) {
    const batch = z
      .object({
        tracker: z.unknown().optional(),
        nutrition: z.unknown().optional(),
      })
      .strict();
    const r = z
      .object({
        baseline: z.unknown(),
        inFlight: batch.nullable(),
        pending: batch,
        startPending: z.boolean(),
      })
      .strict()
      .parse(raw);
    workspace.restore(r.baseline);
    const validate = (value: z.infer<typeof batch>): Batch => {
      const data = validateCloudData(
        {
          tracker: value.tracker ?? workspace.data.tracker,
          nutrition: value.nutrition ?? workspace.data.nutrition,
        },
        workspace.subject,
      );
      return {
        ...(value.tracker ? { tracker: data.tracker } : {}),
        ...(value.nutrition ? { nutrition: data.nutrition } : {}),
      };
    };
    this.inFlight = r.inFlight ? validate(r.inFlight) : null;
    this.pending = validate(r.pending);
    this.startPending = r.startPending;
    return {
      tracker:
        this.pending.tracker ??
        this.inFlight?.tracker ??
        workspace.data.tracker,
      nutrition:
        this.pending.nutrition ??
        this.inFlight?.nutrition ??
        workspace.data.nutrition,
    };
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 200);
  }
  private fail(error: unknown) {
    if (
      error instanceof Error &&
      /AUTHENTICATION_REQUIRED|ACCOUNT_CHANGED/.test(error.message)
    ) {
      this.invalidate(
        "Your session ended. Sign in to load your server records.",
      );
      return;
    }
    this.patch({
      status:
        error instanceof ApiError && error.conflict ? "conflict" : "error",
      message: message(error),
      locked: true,
    });
  }
  async flush(): Promise<void> {
    if (this.saving) return this.saving;
    if (
      !this.workspace ||
      !this.journal ||
      this.recoveryPaused ||
      ["error", "conflict"].includes(this.state.status)
    )
      return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const workspace = this.workspace,
      epoch = this.epoch;
    const run = (async () => {
      while (this.inFlight || this.pending.tracker || this.pending.nutrition) {
        const batch = this.inFlight ?? this.pending;
        if (!this.inFlight) {
          this.inFlight = batch;
          this.pending = {};
        }
        this.patch({ status: "saving" });
        try {
          this.persist();
          let data = workspace.data;
          if (batch.tracker) data = await workspace.saveTracker(batch.tracker);
          if (batch.nutrition)
            data = await workspace.saveNutrition(batch.nutrition);
          this.check(epoch);
          this.inFlight = null;
          try {
            this.persist();
          } catch (error) {
            this.inFlight = batch;
            throw error;
          }
          this.patch({
            data: {
              tracker: this.pending.tracker ?? data.tracker,
              nutrition: this.pending.nutrition ?? data.nutrition,
            },
            locked: false,
          });
        } catch (error) {
          if (epoch === this.epoch) {
            this.fail(error);
          }
          return;
        }
      }
      if (epoch === this.epoch && !this.startPending)
        this.patch({
          status: "saved",
          message: "",
          locked: false,
          day: this.state.date
            ? (workspace.days.get(this.state.date) ?? null)
            : null,
        });
    })();
    this.saving = run;
    void run.finally(() => {
      if (this.saving === run) this.saving = null;
    });
    return run;
  }
  async retry() {
    if (this.state.status === "conflict") return;
    if (!this.savePending()) return;
    this.recoveryPaused = false;
    if (this.startPending) {
      this.patch({ status: "saved" });
      await this.finishStart();
      return;
    }
    if (this.deferredAction) {
      const action = this.deferredAction;
      this.patch({ status: "saved" });
      await this.action(action);
      return;
    }
    this.patch({ status: "pending", message: "" });
    await this.flush();
  }
  async reload() {
    // Explicit discard applies only to this verified account's journal; never prototype stores.
    try {
      this.journal?.clear();
    } catch {
      this.fail(new Error("PENDING_STORAGE_FAILED"));
      return;
    }
    this.api.transport.clear();
    this.invalidate("");
    await this.discover();
  }
  private async action(fn: () => Promise<CloudData>) {
    await this.flush();
    if (!this.workspace || this.state.status !== "saved") return;
    const epoch = this.epoch;
    this.deferredAction = fn;
    this.patch({ locked: true, status: "saving" });
    try {
      const data = await fn();
      this.check(epoch);
      this.deferredAction = null;
      this.patch({
        data,
        locked: !this.journal,
        status: "saved",
        message: this.journal
          ? ""
          : "Another tab is editing this account. This tab is read-only.",
      });
    } catch (error) {
      if (epoch === this.epoch) this.fail(error);
    }
  }
  async start() {
    const workspace = this.workspace;
    await this.flush();
    if (!workspace || this.state.status !== "saved" || !this.journal) return;
    this.startPending = true;
    if (!this.savePending()) return;
    await this.finishStart();
  }
  private async finishStart() {
    const workspace = this.workspace,
      epoch = this.epoch;
    if (!workspace) return;
    this.patch({ locked: true, status: "saving" });
    try {
      const data = await workspace.start();
      this.check(epoch);
      this.startPending = false;
      try {
        this.persist();
      } catch (error) {
        this.startPending = true;
        throw error;
      }
      workspace.acknowledgeStart();
      this.patch({ data, locked: false, status: "saved", message: "" });
    } catch (error) {
      if (epoch === this.epoch) this.fail(error);
    }
  }
  async resume(id: string) {
    const workspace = this.workspace;
    if (!workspace) return;
    await this.action(async () => {
      const r = await this.api.call("GET /v1/workouts/sessions/{id}", {
        params: { id },
      });
      const { workout } = await import("./cloud-workspace");
      workspace.sessions.set(id, r.data);
      workspace.data.tracker.session = workout(r.data, workspace.subject);
      return workspace.project();
    });
  }
  activeWorkouts() {
    return [...(this.workspace?.sessions.values() ?? [])].filter(
      (s) => s.status === "active",
    );
  }
  async loadDay(date: string) {
    this.patch({ date, day: this.workspace?.days.get(date) ?? null });
    const workspace = this.workspace;
    if (workspace)
      await this.action(async () => {
        await workspace.readDay(date);
        return workspace.project();
      });
    if (this.state.phase === "ready")
      this.patch({
        day: this.workspace?.days.get(this.state.date ?? "") ?? null,
      });
  }
  async history(id?: string) {
    const workspace = this.workspace;
    if (workspace)
      await this.action(async () => {
        if (id) return workspace.loadExerciseHistory(id);
        await workspace.loadOlderHistory();
        return workspace.project();
      });
  }
  async recipeVersion(id: string, version: number) {
    const workspace = this.workspace;
    if (!workspace) return;
    const epoch = this.epoch;
    await this.action(async () => {
      const value = await workspace.historicalRecipe(id, version);
      this.check(epoch);
      this.patch({ historicalRecipe: value });
      return workspace.project();
    });
  }
  async logout() {
    try {
      const result = await this.api.transport.logout();
      if (result?.logoutUrl) window.location.assign(result.logoutUrl);
    } catch {
      this.patch({
        message:
          "Sign-out could not be confirmed. Private data is hidden. Retry sign-out before leaving this device.",
      });
    }
  }
}
export function message(error: unknown) {
  if (error instanceof Error && error.message === "PENDING_STORAGE_FAILED")
    return "Device recovery storage failed or is full. Saving is paused; newer edits may exist only in this tab. Download pending edits before closing, then free storage and retry. Existing recovery data has not been deliberately cleared.";
  if (error instanceof ApiError && error.conflict)
    return "Another device changed these records. Saving is paused. Pending edits are kept on this device. Download them before explicitly discarding and reloading server data; newer server records have not been overwritten.";
  if (error instanceof ApiError && error.status === 413)
    return "This change is too large for one server save. Pending edits remain on this device.";
  return "Cloud connection or validation failed. Pending edits are kept on this device for this account. Retry when connected; saving on the server is not yet confirmed.";
}
