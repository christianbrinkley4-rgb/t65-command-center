const COLORS = ["#1d4ed8", "#059669", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#64748b", "#ea580c"];

export default function Donut({ data }: { data: { name: string; value: number }[] }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  let acc = 0;
  const stops = data.map((d, i) => {
    const start = (acc / total) * 100;
    acc += d.value;
    const end = (acc / total) * 100;
    return `${COLORS[i % COLORS.length]} ${start}% ${end}%`;
  });
  const gradient = stops.length ? `conic-gradient(${stops.join(", ")})` : "#e2e8f0";

  return (
    <div className="flex items-center gap-5">
      <div
        className="h-32 w-32 shrink-0 rounded-full"
        style={{
          background: gradient,
          maskImage: "radial-gradient(transparent 42%, black 43%)",
          WebkitMaskImage: "radial-gradient(transparent 42%, black 43%)",
        }}
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        {data.map((d, i) => (
          <div key={d.name} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-slate-600">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: COLORS[i % COLORS.length] }}
              />
              <span className="truncate">{d.name}</span>
            </span>
            <span className="shrink-0 font-medium text-ink">{d.value.toLocaleString()}</span>
          </div>
        ))}
        {data.length === 0 && <p className="text-xs text-slate-400">No data yet.</p>}
      </div>
    </div>
  );
}
