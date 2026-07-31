#!/usr/bin/env python3
"""Turn the monthly call trackers into one CSV of call history.

    python scripts/tracker_xlsx_to_csv.py OUT.csv TRACKER_*.xlsm

The trackers are where the dialing actually got recorded: who was called, when,
what happened, and what it turned into. The CRM has the last status for some of
these people and no dates or dial counts for almost any of them, so this is the
history it never saw.

FOUR THINGS THAT WILL BITE A NAIVE PARSER, all handled here:

1. COLUMNS MOVE BETWEEN FILES. Will's March tracker carries a "Phone 2" column
   that shifts everything right by one, and its attempt column is named
   "Column1" rather than "Att". Everything is looked up BY HEADER NAME. Never
   by position.

2. "Time Called" HOLDS EVERY CALL, not the last one: "7/3 @ 2:23 PM, 7/20 @
   9:47 AM" is two dials. Counting them is more honest than the Att column,
   which is blank in March and zero for untouched rows.

3. THE YEAR IS MISSING. "7/2 @ 11:20 AM" means July 2 of the season the tracker
   was worked. Pass --year if you ever re-run this on an older book.

4. THE DATE COLUMNS CONTAIN PROSE. "Appt Date/Time" holds "reach back out in a
   few hours" and even a first name; "Callback Date" holds a phone number.
   Anything that isn't a real date goes to the notes instead of being forced
   into a date field, because a wrong appointment is worse than none.
"""

import csv
import os
import re
import sys
from datetime import datetime

import openpyxl

DEFAULT_YEAR = 2026

# Header -> the name we use downstream. Lookup is by header text, so a tracker
# that grows a column can't shift the meaning of every field after it.
WANTED = [
    "Name", "Phone", "Phone 2", "City", "County", "Address", "Birthday",
    "Home Value", "Tier", "Prior Result", "Att", "Column1", "Time Called",
    "Call Result", "Outcome", "Appt Date/Time", "Callback Date", "Notes",
]

OUT_FIELDS = [
    "Tracker", "Agent", "Name", "Phone", "Phone 2", "City", "Address",
    "Birthday", "Dials", "First call", "Last call", "All calls",
    "Call result", "Outcome", "Appointment", "Callback", "Prior result",
    "Notes",
]


def clean(v):
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d %H:%M") if (v.hour or v.minute) else v.strftime("%Y-%m-%d")
    return str(v).strip()


def parse_when(text, year):
    """'7/2 @ 11:20 AM' -> (date, 'YYYY-MM-DD HH:MM'). None when it isn't one."""
    s = str(text or "").strip().rstrip(",")
    if not s:
        return None
    # A cell that already held a real date arrives here as "2026-07-22" once
    # clean() has stringified it. Accept that shape too, or recovery silently
    # drops every callback date it restores.
    iso = re.match(r"^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?", s)
    if iso:
        y, mo, d, hh, mi = iso.groups()
        try:
            return datetime(int(y), int(mo), int(d), int(hh or 0), int(mi or 0))
        except ValueError:
            return None
    m = re.match(r"^(\d{1,2})\s*/\s*(\d{1,2})(?:\s*/\s*(\d{2,4}))?"
                 r"(?:\s*@\s*(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]?\.?)?\s*$", s)
    if not m:
        return None
    mo, day, yr, hh, mi, ap = m.groups()
    mo, day = int(mo), int(day)
    if not (1 <= mo <= 12 and 1 <= day <= 31):
        return None
    if yr:
        yr = int(yr)
        if yr < 100:
            yr += 2000
    else:
        yr = year
    hour = int(hh) if hh else 0
    minute = int(mi) if mi else 0
    if ap and ap.lower() == "p" and hour < 12:
        hour += 12
    if ap and ap.lower() == "a" and hour == 12:
        hour = 0
    try:
        return datetime(yr, mo, day, hour, minute)
    except ValueError:
        return None


def parse_calls(text, year):
    """Every timestamp in the cell, oldest first. The count is the dial count."""
    raw = str(text or "")
    if not raw.strip():
        return []
    out = []
    for part in re.split(r"[,;]| and ", raw):
        w = parse_when(part, year)
        if w:
            out.append(w)
    return sorted(out)


def any_date(text, year):
    """A real date, or None. Prose stays prose."""
    if isinstance(text, datetime):
        return text
    return parse_when(text, year)


def row_key(name, phone):
    """Identity within one tracker: the phone, falling back to the name."""
    d = re.sub(r"\D", "", str(phone or ""))
    if len(d) == 11 and d.startswith("1"):
        d = d[1:]
    return d[-10:] if len(d) >= 10 else str(name or "").strip().lower()


def read_raw(path):
    """Every row of a tracker as {key: {header: value}}, for result recovery."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb["Leads"] if "Leads" in wb.sheetnames else wb.worksheets[0]
    rows = list(ws.iter_rows(min_row=1, values_only=True))
    hi = next(i for i, r in enumerate(rows)
              if r and any(str(c).strip() == "Name" for c in r if c is not None))
    hdr = [str(c).strip() if c is not None else "" for c in rows[hi]]
    idx = {h: i for i, h in enumerate(hdr) if h}
    out = {}
    for r in rows[hi + 1:]:
        get = lambda k: clean(r[idx[k]]) if k in idx and idx[k] < len(r) else ""
        if not get("Name"):
            continue
        out[row_key(get("Name"), get("Phone"))] = {k: get(k) for k in idx}
    wb.close()
    return out


# Fields worth restoring from an older copy of the same tracker.
RECOVERABLE = ["Call Result", "Outcome", "Appt Date/Time", "Callback Date", "Notes", "Att"]


def read_tracker(path, year, recovery=None):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = "Leads" if "Leads" in wb.sheetnames else wb.sheetnames[0]
    ws = wb[sheet]
    rows = ws.iter_rows(min_row=1, values_only=True)

    header = None
    for r in rows:
        if r and any(str(c).strip() == "Name" for c in r if c is not None):
            header = [str(c).strip() if c is not None else "" for c in r]
            break
    if header is None:
        wb.close()
        raise SystemExit(f"{os.path.basename(path)}: no header row with a Name column")
    idx = {h: i for i, h in enumerate(header) if h in WANTED}

    def cell(r, key):
        i = idx.get(key)
        return r[i] if i is not None and i < len(r) else None

    # An older save of the same tracker can hold results that were later wiped
    # out of the live file. Only ever FILLS BLANKS — a value in the file you
    # handed me is the current truth and is never overwritten.
    recovered = 0
    base = os.path.basename(path)
    agent = "Christian" if re.search(r"chris", base, re.I) else ("Will" if re.search(r"will", base, re.I) else "")
    label = re.sub(r"\.xls[xm]$", "", base, flags=re.I)

    out, skipped = [], 0
    for r in rows:
        if not r or not clean(cell(r, "Name")):
            continue
        old = (recovery or {}).get(row_key(clean(cell(r, "Name")), clean(cell(r, "Phone"))), {})
        def value(key):
            v = clean(cell(r, key))
            if v or not old.get(key):
                return v
            nonlocal recovered
            recovered += 1
            return old[key]
        calls = parse_calls(cell(r, "Time Called"), year)
        result = value("Call Result")
        outcome = value("Outcome")
        prior = clean(cell(r, "Prior Result"))
        if not (calls or result or outcome or prior):
            skipped += 1
            continue

        # Attempts: count the timestamps first, fall back to the Att column.
        att_raw = value("Att") or clean(cell(r, "Column1"))
        att = int(att_raw) if att_raw.isdigit() else 0
        dials = max(len(calls), att, 1 if (result or outcome) else 0)

        appt = any_date(value("Appt Date/Time"), year)
        callback = any_date(value("Callback Date"), year)
        # Prose that was typed into a date box still says something.
        stray = [clean(cell(r, k)) for k, v in
                 (("Appt Date/Time", appt), ("Callback Date", callback)) if clean(cell(r, k)) and not v]

        out.append({
            "Tracker": label,
            "Agent": agent,
            "Name": clean(cell(r, "Name")),
            "Phone": clean(cell(r, "Phone")),
            "Phone 2": clean(cell(r, "Phone 2")),
            "City": clean(cell(r, "City")),
            "Address": clean(cell(r, "Address")),
            "Birthday": clean(cell(r, "Birthday"))[:10],
            "Dials": dials,
            "First call": calls[0].strftime("%Y-%m-%d %H:%M") if calls else "",
            "Last call": calls[-1].strftime("%Y-%m-%d %H:%M") if calls else "",
            "All calls": " | ".join(c.strftime("%Y-%m-%d %H:%M") for c in calls),
            "Call result": result,
            "Outcome": outcome,
            "Appointment": appt.strftime("%Y-%m-%d %H:%M") if appt else "",
            "Callback": callback.strftime("%Y-%m-%d") if callback else "",
            "Prior result": prior,
            "Notes": " · ".join([value("Notes")] + stray).strip(" ·"),
        })
    wb.close()
    return out, skipped, recovered


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    # --recover-from=OLDER.xlsm fills cells that were wiped out of the live file
    year = DEFAULT_YEAR
    for a in sys.argv[1:]:
        if a.startswith("--year="):
            year = int(a.split("=", 1)[1])
    if len(args) < 2:
        raise SystemExit("Usage: tracker_xlsx_to_csv.py OUT.csv TRACKER.xlsm [more...]")
    out_path, paths = args[0], args[1:]

    recovery = {}
    for a in sys.argv[1:]:
        if a.startswith("--recover-from="):
            recovery.update(read_raw(a.split("=", 1)[1]))
    if recovery:
        print(f"recovery source loaded: {len(recovery)} rows")

    everything, total_skipped = [], 0
    for p in paths:
        rows, skipped, recovered = read_tracker(p, year, recovery)
        total_skipped += skipped
        if recovered:
            print(f"{'':38} recovered {recovered} blank cells from the older copy")
        dials = sum(r["Dials"] for r in rows)
        dated = sum(1 for r in rows if r["Last call"])
        print(f"{os.path.basename(p):38} worked {len(rows):4}  dials {dials:4}  dated {dated:4}  untouched {skipped}")
        everything.extend(rows)

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=OUT_FIELDS)
        w.writeheader()
        w.writerows(everything)

    print(f"\n{len(everything)} worked leads -> {out_path}")
    print(f"{sum(r['Dials'] for r in everything)} dials, "
          f"{sum(1 for r in everything if r['Appointment'])} appointments, "
          f"{sum(1 for r in everything if r['Callback'])} callbacks, "
          f"{total_skipped} never-touched rows left out")


if __name__ == "__main__":
    main()
