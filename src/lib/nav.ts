// Where you can go, listed once.
//
// The header owns five tabs and a Tools drawer; the command palette has to
// offer the same destinations or it becomes a second, quietly different map of
// the app. One list, two readers.
//
// The split is deliberate and was earned: thirteen tabs meant thirteen
// decisions before any work started, and the usage said only a handful carried
// it. TABS is the day, the two ways of working it, the book, and the
// scoreboard. Everything else still exists — it just stopped competing for
// attention with the work.

export type NavItem = {
  href: string;
  label: string;
  /** What you'd actually be going there to do. Shown in the palette. */
  hint: string;
};

export const TABS: NavItem[] = [
  { href: "/calendar/", label: "Day", hint: "Appointments, callbacks and what the week holds" },
  { href: "/session/", label: "Dial", hint: "Power dialer — one lead at a time, one key per result" },
  { href: "/knock/", label: "Knock", hint: "Door routes, planned by street rather than by distance" },
  { href: "/list/", label: "Leads", hint: "The Power List — every pile, every filter, one-tap results" },
  { href: "/stats/", label: "Stats", hint: "Source ROI, show rate, doors versus dials, data health" },
];

export const TOOLS: NavItem[] = [
  { href: "/today/", label: "Today's queue", hint: "Grouped by how late it is" },
  { href: "/search/", label: "Search", hint: "Find anyone by name, number, city or source" },
  { href: "/t65/", label: "T65 Radar", hint: "Who is in the enrollment window, by phase" },
  { href: "/next/", label: "One at a time", hint: "Single-card focus mode with hotkeys" },
  { href: "/import/", label: "Import", hint: "Load a CSV or TSV with dedupe and DNC checks" },
  { href: "/assistant/", label: "AI Assistant", hint: "Paste leads in any shape and approve the parse" },
  { href: "/templates/", label: "Scripts", hint: "Call, voicemail and email templates with merge fields" },
  { href: "/new/", label: "Prospecting", hint: "The never-worked pile" },
  { href: "/sequences/", label: "Sequences", hint: "Nurture cadences and enrollments" },
];

export const ALL_NAV: NavItem[] = [...TABS, ...TOOLS];
