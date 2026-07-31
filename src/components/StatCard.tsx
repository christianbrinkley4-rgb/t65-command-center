export default function StatCard({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string | number;
  sublabel?: string;
}) {
  return (
    <div className="rounded-2xl border border-line bg-white p-4 shadow-card transition hover:shadow-lift">
      <p className="text-[11px] font-medium uppercase tracking-wide text-worked">{label}</p>
      <p className="mt-1 font-display text-3xl font-semibold tabular-nums text-ink">{value}</p>
      {sublabel && <p className="mt-0.5 text-xs text-later">{sublabel}</p>}
    </div>
  );
}
