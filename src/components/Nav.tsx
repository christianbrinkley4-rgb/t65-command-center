"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { RefreshCw, LogOut, Menu, X, Search as SearchIcon } from "lucide-react";
import { useApp } from "@/lib/context";
import { OPEN_PALETTE } from "@/components/CommandPalette";
import { TABS, TOOLS } from "@/lib/nav";
import { WHO_OPTIONS } from "@/lib/types";
import clsx from "clsx";

// Five things you look at, and a drawer for the rest. The lists live in
// lib/nav.ts because the command palette has to offer the same destinations.
const selectClass =
  "rounded-lg border border-night-line bg-white/5 px-2.5 py-1.5 text-sm text-paper outline-none transition hover:bg-white/10 focus:border-brand";

export default function Nav() {
  const pathname = usePathname();
  const { who, setWho, reload, leadsLoading, lastLoadedAt, signOut, me, setMe } = useApp();
  // Twelve tabs wrap into five rows on a phone, and this header is sticky —
  // so below sm it collapses to a menu button and the page keeps its screen.
  const [open, setOpen] = useState(false);

  const [toolsOpen, setToolsOpen] = useState(false);
  // Closing on mouse-leave alone means the menu stays open forever on a touch
  // screen, which is the device this actually runs on.
  const toolsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!toolsOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!toolsRef.current?.contains(e.target as Node)) setToolsOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setToolsOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [toolsOpen]);

  const isActive = (href: string) => pathname === href || pathname === href.slice(0, -1);
  const current = [...TABS, ...TOOLS].find((t) => isActive(t.href));

  useEffect(() => {
    setOpen(false);
    setToolsOpen(false);
  }, [pathname]);

  return (
    <header className="sticky top-0 z-20 bg-night text-paper shadow-command">
      {/* One compact bar on mobile; the full wrapped layout from sm up. */}
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:flex-wrap">
        <Link href="/calendar/" className="flex shrink-0 items-baseline gap-1.5">
          <span className="font-display text-lg font-semibold tracking-tight text-paper">T65</span>
          <span className="hidden text-[11px] font-medium uppercase tracking-[0.2em] text-brand sm:inline">
            Command
          </span>
        </Link>

        {/* Mobile: current page name, then the menu toggle */}
        <span className="flex-1 truncate text-sm font-medium text-night-soft sm:hidden">
          {current?.label || ""}
        </span>

        <nav className="ml-2 hidden flex-1 items-center gap-0.5 sm:flex">
          {TABS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className={clsx(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition",
                isActive(t.href)
                  ? "bg-brand text-white shadow-sm"
                  : "text-night-soft hover:bg-white/10 hover:text-paper"
              )}
            >
              {t.label}
            </Link>
          ))}

          <div className="relative" ref={toolsRef}>
            <button
              onClick={() => setToolsOpen((v) => !v)}
              aria-expanded={toolsOpen}
              className={clsx(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition",
                TOOLS.some((t) => isActive(t.href))
                  ? "bg-brand text-white shadow-sm"
                  : "text-night-soft hover:bg-white/10 hover:text-paper"
              )}
            >
              Tools
            </button>
            {toolsOpen && (
              <div
                onMouseLeave={() => setToolsOpen(false)}
                className="absolute left-0 z-30 mt-1 w-48 overflow-hidden rounded-xl border border-night-line bg-night shadow-lift"
              >
                {TOOLS.map((t) => (
                  <Link
                    key={t.href}
                    href={t.href}
                    className={clsx(
                      "block px-3 py-2 text-sm transition",
                      isActive(t.href) ? "bg-brand text-white" : "text-night-soft hover:bg-white/10 hover:text-paper"
                    )}
                  >
                    {t.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </nav>

        <select
          value={who}
          onChange={(e) => setWho(e.target.value as any)}
          aria-label="Whose tasks to show"
          title="Everyone shows the shared pool. Pick a name to see just that person's assigned tasks."
          className={clsx(selectClass, "hidden sm:block")}
        >
          {WHO_OPTIONS.map((o) => (
            <option key={o} value={o} className="text-ink">
              {o === "Everyone" ? "Everyone" : `${o}'s tasks`}
            </option>
          ))}
        </select>

        <select
          value={me}
          onChange={(e) => setMe(e.target.value)}
          aria-label="Who is logging activity"
          title="Who is logging activity right now (shared login)"
          className={clsx(selectClass, "hidden sm:block")}
        >
          <option value="Christian" className="text-ink">
            I&apos;m Christian
          </option>
          <option value="Will" className="text-ink">
            I&apos;m Will
          </option>
        </select>

        {/* The palette needs somewhere to be discovered. A keyboard shortcut
            nobody has been told about is a feature that doesn't exist. */}
        <button
          onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE))}
          aria-label="Search leads and pages"
          title="Find anyone, or go anywhere (Ctrl+K)"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-night-line px-2.5 py-1.5 text-sm text-night-soft transition hover:bg-white/10 hover:text-paper"
        >
          <SearchIcon size={14} aria-hidden />
          <kbd className="hidden font-sans text-[10px] tracking-wide text-night-soft/70 lg:inline">
            Ctrl K
          </kbd>
        </button>

        <button
          onClick={() => reload()}
          disabled={leadsLoading}
          aria-label="Refresh leads"
          title={lastLoadedAt ? `Last loaded ${lastLoadedAt.toLocaleTimeString()}` : "Refresh leads"}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-night-line px-2.5 py-1.5 text-sm text-night-soft transition hover:bg-white/10 hover:text-paper disabled:opacity-50"
        >
          <RefreshCw size={14} aria-hidden className={leadsLoading ? "animate-spin" : ""} />
        </button>

        <button
          onClick={() => signOut()}
          aria-label="Sign out"
          title="Sign out"
          className="hidden shrink-0 items-center gap-1 rounded-lg border border-night-line px-2.5 py-1.5 text-sm text-night-soft transition hover:bg-white/10 hover:text-paper sm:flex"
        >
          <LogOut size={14} aria-hidden />
        </button>

        <button
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          className="flex shrink-0 items-center rounded-lg border border-night-line p-2 text-night-soft transition hover:bg-white/10 hover:text-paper sm:hidden"
        >
          {open ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
        </button>
      </div>

      {/* Mobile drawer — scrolls on its own so it can never trap the page */}
      {open && (
        <div className="max-h-[70vh] overflow-y-auto border-t border-night-line px-4 pb-4 pt-2 sm:hidden">
          <div className="grid grid-cols-2 gap-1.5">
            {[...TABS, ...TOOLS].map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className={clsx(
                  "rounded-lg px-3 py-2.5 text-sm font-medium transition",
                  isActive(t.href) ? "bg-brand text-white" : "bg-white/5 text-night-soft hover:bg-white/10"
                )}
              >
                {t.label}
              </Link>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            <select
              value={who}
              onChange={(e) => setWho(e.target.value as any)}
              aria-label="Whose tasks to show"
              className={selectClass}
            >
              {WHO_OPTIONS.map((o) => (
                <option key={o} value={o} className="text-ink">
                  {o === "Everyone" ? "Everyone" : `${o}'s tasks`}
                </option>
              ))}
            </select>
            <select
              value={me}
              onChange={(e) => setMe(e.target.value)}
              aria-label="Who is logging activity"
              className={selectClass}
            >
              <option value="Christian" className="text-ink">
                I&apos;m Christian
              </option>
              <option value="Will" className="text-ink">
                I&apos;m Will
              </option>
            </select>
          </div>
          <button
            onClick={() => signOut()}
            className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-night-line px-2.5 py-2.5 text-sm text-night-soft transition hover:bg-white/10 hover:text-paper"
          >
            <LogOut size={14} aria-hidden /> Sign out
          </button>
        </div>
      )}
    </header>
  );
}
