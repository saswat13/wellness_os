import type { ExerciseSet } from "@/lib/models";
import type { ExercisePerformance } from "@/lib/tracker";
import { displayLoad, type Unit } from "@/lib/workout";
import { groupSets, setCounts, sideComparison } from "@/lib/unilateral";
export function SideComparison({
  sets,
  unit = "kg",
  title = "Left / right comparison",
}: {
  sets: ExerciseSet[];
  unit?: Unit;
  title?: string;
}) {
  const comparison = sideComparison(sets);
  const load = (n: number | null) =>
    n === null ? "—" : `${displayLoad(n, unit)} ${unit}`;
  const metrics = [
    ["Completed sides", comparison.left.completed, comparison.right.completed],
    ["Total reps", comparison.left.reps, comparison.right.reps],
    [
      "Average load",
      load(comparison.left.averageLoad),
      load(comparison.right.averageLoad),
    ],
    [
      "Average RPE",
      comparison.left.averageRpe?.toFixed(1) ?? "—",
      comparison.right.averageRpe?.toFixed(1) ?? "—",
    ],
    [
      `Volume (${unit} × reps)`,
      displayLoad(comparison.left.volume, unit).toLocaleString(),
      displayLoad(comparison.right.volume, unit).toLocaleString(),
    ],
  ];
  return (
    <div className="mt-3 rounded-xl border border-[#dfe5dc] bg-[#fafbf8] p-3">
      <h3 className="mb-2 text-sm font-bold">{title}</h3>
      <table className="w-full table-fixed text-left text-xs">
        <thead>
          <tr className="text-[#6c7c6e]">
            <th className="w-1/2 py-2" scope="col">
              Metric
            </th>
            <th scope="col">Left</th>
            <th scope="col">Right</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map(([label, left, right]) => (
            <tr key={label} className="border-t border-[#e3e8de]">
              <th className="py-2 pr-2 font-normal" scope="row">
                {label}
              </th>
              <td className="break-words">{left}</td>
              <td className="break-words">{right}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs leading-5 text-[#6c7c6e]">
        {comparison.matchedPairs
          ? `Matched-pair volume difference (Right − Left): ${displayLoad(comparison.matchedVolumeDelta, unit)} ${unit} × reps across ${comparison.matchedPairs} complete pairs.`
          : "Complete both sides of a pair to compare matched volume."}
      </p>
      <p className="mt-2 text-[10px] leading-4 text-[#7b897a]">
        Totals include completed sides, including partial pairs. Matched
        comparisons use pairs with both sides complete. Differences in load or
        reps are logging observations, not a strength diagnosis.
      </p>
    </div>
  );
}
export function PerformanceHistory({
  sessions,
  unit = "kg",
}: {
  sessions: ExercisePerformance[];
  unit?: Unit;
}) {
  const unilateral = sessions.filter((h) => h.unilateral);
  return (
    <div className="space-y-4">
      {unilateral.length > 0 && (
        <SideComparison
          sets={unilateral.flatMap((h) => h.sets)}
          unit={unit}
          title="Left / right performance analytics"
        />
      )}
      {sessions.map((h) => {
        const counts = setCounts(h.sets);
        return (
          <div
            key={`${h.sessionId}-${h.entryId}`}
            className="rounded-2xl bg-white p-3"
          >
            <h3 className="text-sm font-bold">
              {new Date(h.date + "T12:00:00").toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}{" "}
              · {h.name}
            </h3>
            <p className="my-2 text-xs text-[#6c7c6e]">
              {counts.completed} completed {h.unilateral ? "pairs" : "sets"}
              {counts.partial ? ` · ${counts.partial} partial pairs` : ""}
              {h.mock ? " · mock" : ""}
            </p>
            {groupSets(h.sets).map((group, index) => (
              <div key={group.id} className="mb-2 rounded-xl bg-[#f6f7f3] p-3">
                <p className="mb-2 text-xs font-bold">
                  Set {index + 1}
                  {group.partial ? " · Partially complete" : ""}
                </p>
                {group.rows.map((s) => (
                  <div
                    key={s.id}
                    className="flex flex-wrap justify-between gap-2 py-1 text-xs"
                  >
                    <span className="font-semibold">
                      {s.side === "L"
                        ? "Left"
                        : s.side === "R"
                          ? "Right"
                          : "Both"}
                    </span>
                    <span>
                      {s.reps} × {displayLoad(s.kg, unit).toFixed(1)} {unit}
                      {s.rpe ? ` · RPE ${s.rpe}` : ""}
                    </span>
                    <span
                      className={s.done ? "text-[#355f47]" : "text-[#7b897a]"}
                    >
                      {s.done ? "Completed" : "Not completed"}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {h.unilateral && <SideComparison sets={h.sets} unit={unit} />}
          </div>
        );
      })}
    </div>
  );
}
