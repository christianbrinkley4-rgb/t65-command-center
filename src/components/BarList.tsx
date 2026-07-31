const COLORS = ["#1d4ed8", "#059669", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#64748b", "#ea580c"];

export default function BarList({ data }: { data: { name: string; value: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="space-y-2.5">
      {data.map((d, i) => (
        <div key={d.name}>
          <div className="mb-1 flex justify-between text-xs">
            <span className="truncate text-slate-600">{d.name}</span>
            <span className="font-medium text-ink">{d.value.toLocaleString()}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full"
              style={{
                width: `${(d.value / max) * 100}%`,
                backgroundColor: COLORS[i % COLORS.length],
              }}
            />
          </div>
        </div>
      ))}
      {data.length === 0 && <p className="text-xs text-slate-400">No data yet.</p>}
    </div>
  );
}
