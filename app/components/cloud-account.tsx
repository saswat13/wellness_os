"use client";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { CloudController } from "@/lib/cloud-controller";
import type { CloudData, Day } from "@/lib/cloud-workspace";
import type { Dispatch, SetStateAction } from "react";
import type { TrackerStore } from "@/lib/models";
import type { NutritionStore } from "@/lib/nutrition";
import { action, control } from "./management";
import { primary, panel, NutritionNumbers } from "./nutrition";
export type CloudBinding = {
  data: CloudData;
  setTracker: Dispatch<SetStateAction<TrackerStore>>;
  setNutrition: Dispatch<SetStateAction<NutritionStore>>;
  loadDay: (date: string) => void;
  loadHistory: (id: string) => Promise<void>;
  day: Day | null;
};
function modeUrl(cloud: boolean) {
  const u = new URL(window.location.href);
  if (cloud) u.searchParams.set("mode", "cloud");
  else {
    u.searchParams.delete("mode");
    u.searchParams.delete("draft");
  }
  return u.pathname + u.search;
}
export function AccountBoundary({
  render,
}: {
  render: (cloud?: CloudBinding) => ReactNode;
}) {
  const [mode, setMode] = useState<"boot" | "local" | "cloud">("boot");
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setMode(
          new URLSearchParams(window.location.search).get("mode") === "cloud"
            ? "cloud"
            : "local",
        ),
      0,
    );
    return () => clearTimeout(timer);
  }, []);
  const choose = (cloud: boolean) => {
    window.history.replaceState(null, "", modeUrl(cloud));
    setMode(cloud ? "cloud" : "local");
  };
  if (mode === "boot")
    return <main className="mx-auto max-w-3xl p-8">Loading FORM…</main>;
  if (mode === "cloud")
    return <CloudAccount render={render} onLocal={() => choose(false)} />;
  return (
    <>
      <div className="border-b border-[#dfe5dc] bg-[#edf1e7]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-5 py-1 text-xs">
          <span>Local data stays in this browser.</span>
          <button
            className={`${action} text-[#244b3c]`}
            onClick={() => choose(true)}
          >
            Use cloud account
          </button>
        </div>
      </div>
      {render()}
    </>
  );
}
function CloudAccount({
  render,
  onLocal,
}: {
  render: (cloud: CloudBinding) => ReactNode;
  onLocal: () => void;
}) {
  const [controller] = useState(() => new CloudController());
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const [recipeId, setRecipeId] = useState("");
  const [version, setVersion] = useState(1);
  useEffect(() => {
    const disconnect = controller.connect();
    void controller.discover();
    const check = () => {
      if (document.visibilityState === "visible")
        void controller.refreshAuthentication();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (controller.unsaved && !controller.snapshot().durable) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("beforeunload", unload);
    const interval = setInterval(check, 60000);
    // Defer disposal by one microtask so Strict Mode's effect replay can reconnect safely.
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("beforeunload", unload);
      disconnect();
    };
  }, [controller]);
  useEffect(() => {
    if (state.phase !== "ready" || !state.data) return;
    const id = state.data.tracker.session.id;
    const active = controller.activeWorkouts().some((s) => s.id === id);
    const u = new URL(window.location.href);
    if (active) u.searchParams.set("draft", id);
    else u.searchParams.delete("draft");
    u.searchParams.set("mode", "cloud");
    window.history.replaceState(null, "", u.pathname + u.search);
  }, [state.phase, state.data, controller]);
  const leave = () => {
    if (
      !controller.unsaved ||
      state.durable ||
      window.confirm(
        "Device recovery failed. Leave and lose newer in-memory cloud edits? Download them first. Existing prototype records stay unchanged.",
      )
    ) {
      controller.api.transport.clear();
      controller.dispose();
      onLocal();
    }
  };
  const logout = async () => {
    if (
      controller.unsaved &&
      !state.durable &&
      !window.confirm(
        "Device recovery failed. Sign out and lose newer in-memory edits? Download them first.",
      )
    )
      return;
    await controller.logout();
  };
  const backup = () => {
    if (!state.data) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(controller.recoveryExport(), null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "form-cloud-pending.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const toolbar = (
    <div className="border-b border-[#dfe5dc] bg-[#edf1e7]">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-2 text-xs">
        <span className="mr-auto min-w-0 break-all font-semibold">
          {state.subject
            ? `Cloud account · ${state.subject}`
            : "FORM cloud account"}
        </span>
        <button className={action} onClick={leave}>
          Use local prototype
        </button>
        {state.subject && (
          <a
            href="/auth/login"
            className={action}
            onClick={(event) => {
              if (
                controller.unsaved &&
                !state.durable &&
                !window.confirm(
                  "Device recovery failed. Switch accounts and lose newer in-memory edits? Download them first.",
                )
              ) {
                event.preventDefault();
                return;
              }
              controller.api.transport.beginAccountSwitch();
            }}
          >
            Switch account
          </a>
        )}
        <button className={action} onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </div>
  );
  if (state.phase !== "ready" || !state.data)
    return (
      <>
        {toolbar}
        <main className="mx-auto max-w-xl px-4 py-12">
          <div className={`${panel} space-y-4`}>
            <h1 className="text-3xl font-bold">Your FORM account.</h1>
            {state.phase === "loading" ? (
              <p role="status">
                Checking your session and loading server records…
              </p>
            ) : (
              <>
                <p role={state.message ? "alert" : undefined}>
                  {state.message ||
                    "Sign in to keep workouts and meals in your account across devices. Your local prototype records stay separate."}
                </p>
                <a className={primary} href="/auth/login">
                  Sign in to FORM
                </a>
                <button
                  className={action}
                  onClick={() => void controller.discover()}
                >
                  Retry session discovery
                </button>
              </>
            )}
            <p className="text-xs text-[#6c7c6e]">
              Invitation-only. Cloud mode requires the same-origin
              authentication service. No browser records are imported.
            </p>
          </div>
        </main>
      </>
    );
  const data = state.data;
  return (
    <>
      {toolbar}
      <section
        aria-label="Cloud synchronization"
        className="mx-auto max-w-3xl space-y-2 px-4 pt-3 text-sm"
      >
        <div
          role="status"
          aria-live="polite"
          className="flex flex-wrap items-center gap-2"
        >
          <span className="mr-auto font-semibold">
            {state.status === "saved"
              ? "Saved on server"
              : state.status === "pending"
                ? "Pending · saved on this device"
                : state.status === "saving"
                  ? "Saving to server…"
                  : state.status === "conflict"
                    ? "Save conflict · paused"
                    : state.durable
                      ? "Failed · pending edits kept on device"
                      : "Failed · device recovery unavailable"}
          </span>
          <button
            className={action}
            disabled={state.locked}
            onClick={() => void controller.start()}
          >
            Start new workout
          </button>
          {controller.activeWorkouts().length > 1 && (
            <select
              aria-label="Resume unfinished workout"
              disabled={state.locked}
              className={control}
              value={data.tracker.session.id}
              onChange={(e) => void controller.resume(e.target.value)}
            >
              {controller.activeWorkouts().map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {state.message && (
          <div role="alert" className="rounded-xl bg-amber-100 p-3">
            <p>{state.message}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {state.status === "saved" ? (
                <button
                  className={action}
                  onClick={() => void controller.discover()}
                >
                  Retry session discovery
                </button>
              ) : (
                state.status !== "conflict" && (
                  <button
                    className={action}
                    onClick={() => void controller.retry()}
                  >
                    Retry cloud save
                  </button>
                )
              )}
              {state.status !== "saved" && (
                <>
                  <button className={action} onClick={backup}>
                    Download pending cloud edits
                  </button>
                  <button
                    className={action}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Discard this account's pending changes from this device and reload server data? Download pending edits first if you want to keep them.",
                        )
                      )
                        void controller.reload();
                    }}
                  >
                    Reload server data
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        <p className="text-xs text-[#6c7c6e]">
          Pending edits stay on this device for this account until saved or
          explicitly discarded. Sign-out hides them; sign back into the same
          account to recover. Server saves require a connection. Workouts
          initially show the past year; nutrition loads this week and selected
          diary dates.
        </p>
        <button
          className={action}
          disabled={state.locked}
          onClick={() => void controller.history()}
        >
          Load earlier workout history
        </button>
        {data.nutrition.recipes.length > 0 && (
          <details className={panel}>
            <summary className="min-h-11 cursor-pointer py-2 font-semibold">
              Historical recipe versions
            </summary>
            <form
              className="mt-2 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void controller.recipeVersion(
                  recipeId || data.nutrition.recipes[0].id,
                  version,
                );
              }}
            >
              <select
                className={control}
                aria-label="Recipe history"
                value={recipeId || data.nutrition.recipes[0].id}
                onChange={(e) => setRecipeId(e.target.value)}
              >
                {data.nutrition.recipes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <input
                className={control}
                aria-label="Recipe version"
                type="number"
                min={1}
                step={1}
                value={version}
                onChange={(e) => setVersion(e.target.valueAsNumber)}
                required
              />
              <button className={action} disabled={state.locked}>
                View recipe version
              </button>
            </form>
            {state.historicalRecipe && (
              <div className="mt-3">
                <p className="font-semibold">
                  {state.historicalRecipe.name} ·{" "}
                  {state.historicalRecipe.finishedGrams} g finished yield
                </p>
                {state.historicalRecipe.ingredients.map((i) => (
                  <div key={i.id} className="py-2">
                    <p>
                      {i.snapshot.name} · {i.snapshot.preparation} · {i.grams} g
                    </p>
                    <NutritionNumbers
                      value={i.snapshot.per100g}
                      suffix=" / 100 g"
                    />
                  </div>
                ))}
                <p className="text-xs">
                  Read-only historical version. Current recipes and logged
                  portions are unchanged.
                </p>
              </div>
            )}
          </details>
        )}
      </section>
      <fieldset className="contents" disabled={state.locked}>
        {render({
          data,
          setTracker: controller.setTracker,
          setNutrition: controller.setNutrition,
          loadDay: (date) => {
            void controller.loadDay(date);
          },
          loadHistory: (id) => controller.history(id),
          day: state.day,
        })}
      </fieldset>
    </>
  );
}
