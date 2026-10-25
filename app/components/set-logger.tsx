"use client";
import { Check, Minus, Plus } from "lucide-react";
import type { ExerciseSet, SessionExercise } from "@/lib/models";
import { displayLoad, toKg, type Unit } from "@/lib/workout";
import { groupSets } from "@/lib/unilateral";
import { action } from "./management";
export function SetLogger({
  entry,
  sets,
  unit,
  showRpe,
  onEdit,
  onSharedWeight,
  onAdd,
  onRemove,
  onRest,
}: {
  entry: SessionExercise;
  sets: ExerciseSet[];
  unit: Unit;
  showRpe: boolean;
  onEdit: (
    id: string,
    patch: Partial<Pick<ExerciseSet, "reps" | "kg" | "rpe" | "done">>,
  ) => void;
  onSharedWeight: (enabled: boolean) => void;
  onAdd: () => void;
  onRemove: (groupId: string) => void;
  onRest: () => void;
}) {
  const groups = groupSets(sets);
  const name = entry.snapshot.name;
  const grid = showRpe
    ? "grid-cols-[40px_1fr_1fr_44px] sm:grid-cols-[40px_1fr_1fr_54px_44px]"
    : "grid-cols-[40px_1fr_1fr_44px]";
  return (
    <div>
      {entry.snapshot.unilateral && (
        <div className="mb-4 rounded-xl bg-[#edf2e6] p-3">
          <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
            <input
              aria-label={`${name}: Same weight for both sides`}
              type="checkbox"
              checked={entry.sameWeight}
              onChange={(e) => onSharedWeight(e.target.checked)}
              className="h-4 w-4 accent-[#244b3c]"
            />
            Same weight for both sides
          </label>
          <p className="text-xs leading-5 text-[#6c7c6e]">
            Copies weight edits within a pair. Previous left/right values stay
            intact until you edit. Turn off for different loads.
          </p>
        </div>
      )}
      <div
        className={`grid items-center gap-2 text-center text-[10px] font-bold tracking-widest text-[#7d887b] ${grid}`}
      >
        <span>SIDE</span>
        <span>REPS</span>
        <span>LOAD ({unit.toUpperCase()})</span>
        {showRpe && <span className="hidden sm:block">RPE</span>}
        <span>DONE</span>
      </div>
      <div className="mt-2 space-y-3">
        {groups.map((group, index) => (
          <div
            role="group"
            aria-label={`${name} set ${index + 1}`}
            key={group.id}
            className={`rounded-xl border p-2 ${group.complete ? "border-[#c8dcb2] bg-[#f6f9f1]" : "border-[#e3e8de]"}`}
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs font-bold">Set {index + 1}</span>
              <span className="text-[10px] text-[#6c7c6e]">
                {group.complete
                  ? "Complete"
                  : group.partial
                    ? "1 of 2 sides complete"
                    : entry.snapshot.unilateral
                      ? "Left + right"
                      : "Ready"}
              </span>
              <button
                aria-label={`Remove ${name} set ${index + 1}${entry.snapshot.unilateral ? " pair" : ""}`}
                className="flex min-h-11 min-w-11 items-center justify-center text-[#899384]"
                onClick={() => onRemove(group.id)}
              >
                <Minus size={16} />
              </button>
            </div>
            <div className="space-y-2">
              {group.rows.map((s) => (
                <div
                  key={s.id}
                  className={`grid items-center gap-2 rounded-xl py-1 ${s.done ? "bg-[#eff5e8]" : ""} ${grid}`}
                >
                  <span className="text-center text-xs font-semibold">
                    {s.side === "L"
                      ? "Left"
                      : s.side === "R"
                        ? "Right"
                        : "Both"}
                  </span>
                  <input
                    aria-label={`${name} set ${index + 1} ${s.side} reps`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={999}
                    step={1}
                    value={s.reps}
                    onChange={(e) =>
                      onEdit(s.id, {
                        reps: Math.min(
                          999,
                          Math.max(0, Math.floor(Number(e.target.value))),
                        ),
                      })
                    }
                    className="h-12 min-w-0 w-full rounded-xl border border-[#dde3d8] bg-[#fafbf8] text-center text-base font-semibold"
                  />
                  <input
                    aria-label={`${name} set ${index + 1} ${s.side} weight in ${unit}`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={10000}
                    step={0.5}
                    value={displayLoad(s.kg, unit)}
                    onChange={(e) =>
                      onEdit(s.id, {
                        kg: toKg(
                          Math.min(10000, Math.max(0, Number(e.target.value))),
                          unit,
                        ),
                      })
                    }
                    className="h-12 min-w-0 w-full rounded-xl border border-[#dde3d8] bg-[#fafbf8] text-center text-base font-semibold"
                  />
                  {showRpe && (
                    <div className="order-last col-span-4 flex items-center justify-end gap-2 sm:order-none sm:col-span-1 sm:block">
                      <span className="text-xs text-[#7b897a] sm:hidden">
                        {s.side === "L"
                          ? "Left"
                          : s.side === "R"
                            ? "Right"
                            : "Set"}{" "}
                        RPE
                      </span>
                      <select
                        aria-label={`${name} set ${index + 1} ${s.side} RPE`}
                        value={s.rpe}
                        onChange={(e) => onEdit(s.id, { rpe: e.target.value })}
                        className="h-12 min-w-0 rounded-xl border border-[#dde3d8] bg-[#fafbf8] px-2 text-center text-xs"
                      >
                        <option value="">—</option>
                        {[5, 6, 7, 8, 9, 10].map((n) => (
                          <option key={n}>{n}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <button
                    aria-label={`${s.done ? "Uncomplete" : "Complete"} ${name} set ${index + 1} ${s.side}`}
                    aria-pressed={s.done}
                    onClick={() => {
                      onEdit(s.id, { done: !s.done });
                      if (!s.done) onRest();
                    }}
                    className={`flex h-12 w-11 items-center justify-center rounded-xl border ${s.done ? "border-[#244b3c] bg-[#244b3c] text-[#d6ecb4]" : "border-[#dce3d7] text-[#b5c1b0]"}`}
                  >
                    <Check size={20} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <button className={`${action} mt-3 text-[#57775d]`} onClick={onAdd}>
        <Plus size={16} />
        Add {entry.snapshot.unilateral ? "left / right pair" : "set"}
      </button>
    </div>
  );
}
