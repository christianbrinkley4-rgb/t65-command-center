"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { useApp } from "@/lib/context";

export default function LoginScreen() {
  const { signIn } = useApp();
  // Email prefills for convenience; the password must NEVER be prefilled or
  // appear anywhere in source — this bundle ships to a public static host,
  // and a hardcoded password would hand the whole book to anyone who reads it.
  const [email, setEmail] = useState("team@bankerst65.com");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await signIn(email, password);
    setBusy(false);
    if (err) setError(err.message || "Sign in failed");
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <div className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-brand/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-24 h-96 w-96 rounded-full bg-week/10 blur-3xl" />

      <div className="w-full max-w-sm animate-fade-up">
        <div className="mb-6 flex items-baseline gap-2">
          <span className="font-display text-3xl font-semibold tracking-tight text-ink">T65</span>
          <span className="text-xs font-medium uppercase tracking-[0.24em] text-brand">
            Command Center
          </span>
        </div>

        <div className="rounded-2xl border border-line bg-white/80 p-7 shadow-lift backdrop-blur">
          <h1 className="font-display text-xl font-semibold text-ink">Welcome back.</h1>
          <p className="mt-1 text-sm text-worked">The shared desk for Christian and Will.</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-worked">
                Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-line bg-paper/50 px-3.5 py-2.5 text-sm outline-none transition focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand/20"
              />
            </div>
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-worked">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-line bg-paper/50 px-3.5 py-2.5 text-sm outline-none transition focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand/20"
              />
            </div>
            {error && <p className="text-sm text-overdue">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="group flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-dark disabled:opacity-60"
            >
              {busy ? "Signing in…" : "Enter the command center"}
              {!busy && <ArrowRight size={15} className="transition group-hover:translate-x-0.5" />}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-xs text-worked">
          Prefilled for the team. Just hit enter.
        </p>
      </div>
    </div>
  );
}
