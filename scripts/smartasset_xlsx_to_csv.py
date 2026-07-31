#!/usr/bin/env python3
"""Convert the SmartAsset "Leads received" export into a CSV the CRM can take.

    python scripts/smartasset_xlsx_to_csv.py OUT.csv "Leads_received.xlsx"

Two different things live in this sheet and they must not be mixed:

  NOTES is a running CALL HISTORY typed by hand — "left vm(10/16), sent 3week
  followup email(9/23), left vm email Christian (7/9)". This is the thing you
  want in front of you while the phone rings, so it goes to raw_notes.

  The other 17 columns are the SmartAsset SURVEY: assets, income, retirement
  timing, whether they already have an advisor, homeowner, married, estate
  plan. Static facts about the person, not a history, so they're folded into a
  single readable profile line and kept in their own field.

DIALS/TXTs and LAST CALLED are real attempt history the CRM has never had for
these leads, and they come across as-is.
"""

import csv
import os
import re
import sys
from datetime import datetime

import openpyxl

OUT_FIELDS = [
    "Name", "Phone", "Email", "Zip", "Lead received", "Dials", "Last called",
    "Emails", "Last emailed", "Notes", "Profile",
]

# Column -> how it reads in the profile line. Order is the order you'd want it
# said out loud: money first, timing next, then the situational stuff.
PROFILE_FIELDS = [
    ("ASSETS", "assets"),
    ("INCOME", "income"),
    ("RETIRE TIME", "retires in"),
    ("AGE", "age"),
    ("DESIRED EXPERTISE", "wants"),
    ("HAS ADVISOR?", "advisor"),
    ("401K", "401k"),
    ("IRA", "IRA"),
    ("ESTATE PLAN", "estate plan"),
    ("MARRIED", "married"),
    ("HOMEOWNER", "homeowner"),
    ("BUSINESS OWNER", "business owner"),
    ("HEALTH", "health"),
    ("LIFE STAGES", "stage"),
    ("INVESTMENT COMFORT LEVEL", "comfort"),
    ("TIME TO IMPROVE", "time to improve"),
    ("DRIVE TO ADVISOR", "will drive"),
]


def clean(v):
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d")
    return re.sub(r"\s+", " ", str(v)).strip()


def as_date(v):
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d")
    s = clean(v)
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return m.group(0)
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", s)
    if m:
        mo, d, y = m.groups()
        return f"{y}-{int(mo):02d}-{int(d):02d}"
    return ""


def as_int(v):
    s = re.sub(r"\D", "", clean(v))
    return int(s) if s else 0


def profile_line(get):
    """One line: 'assets 250K-1MIL · income $100-149k · retires in 1-4 yrs …'"""
    bits = []
    for col, label in PROFILE_FIELDS:
        val = clean(get(col))
        if not val or val.lower() in ("n/a", "none", "unknown", "-"):
            continue
        # "MARRIED: Yes" reads better as just "married".
        if val.lower() in ("yes", "true"):
            bits.append(label)
        elif val.lower() in ("no", "false"):
            bits.append(f"no {label}")
        else:
            bits.append(f"{label} {val}")
    return " · ".join(bits)


def main():
    if len(sys.argv) < 3:
        raise SystemExit("Usage: smartasset_xlsx_to_csv.py OUT.csv Leads_received.xlsx")
    out_path, src = sys.argv[1], sys.argv[2]

    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    ws = wb["Sheet1"] if "Sheet1" in wb.sheetnames else wb.worksheets[0]
    rows = list(ws.iter_rows(min_row=1, values_only=True))
    # Headers are upper-cased so lookups can't be defeated by "DIALS/TXTs"
    # having one lowercase letter. Every key below must therefore be UPPER.
    hdr = [clean(c).upper() for c in rows[0]]
    idx = {h: i for i, h in enumerate(hdr) if h}

    out = []
    for r in rows[1:]:
        get = lambda k: r[idx[k]] if k in idx and idx[k] < len(r) else None
        name = clean(get("NAME"))
        if not name:
            continue
        out.append({
            "Name": name,
            "Phone": clean(get("PHONE #")),
            "Email": clean(get("EMAIL")),
            "Zip": clean(get("ZIP CODE")),
            "Lead received": as_date(get("LEAD RECEIVED")),
            "Dials": as_int(get("DIALS/TXTS")),
            "Last called": as_date(get("LAST CALLED")),
            "Emails": as_int(get("EMAILS")),
            "Last emailed": as_date(get("LAST EMAILED")),
            "Notes": clean(get("NOTES")),
            "Profile": profile_line(get),
        })
    wb.close()

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=OUT_FIELDS)
        w.writeheader()
        w.writerows(out)

    print(f"{len(out)} SmartAsset leads -> {out_path}")
    print(f"  with call notes      {sum(1 for r in out if r['Notes'])}")
    print(f"  with a dial count    {sum(1 for r in out if r['Dials'])}  ({sum(r['Dials'] for r in out)} dials total)")
    print(f"  with a last-called   {sum(1 for r in out if r['Last called'])}")
    print(f"  with an email        {sum(1 for r in out if r['Email'])}")
    print(f"  with a profile       {sum(1 for r in out if r['Profile'])}")


if __name__ == "__main__":
    main()
