"""
Parse OSCR rows PASTED as text (copied out of the Pega grid) into the clean CSV
that scripts/import-oscr-csv.mjs imports.

Same data as the .xlsx export, different failure modes:
  * Records run together as one long line-per-cell stream with no delimiter
    other than the trailing OSCR lead ID.
  * The leading columns vary — some records start with days-assigned, others
    with "# of times disp." plus a last-disposition date first.
  * "Do not call" appears INLINE between the phone and the city, and some
    records have no phone line at all. Positional parsing from the left gets
    these wrong; parsing BACKWARD from the OSCR ID is stable because the tail
    (id, orig date, street, zip, city) is always the same shape.

Usage:
    python scripts/oscr_paste_to_csv.py paste.txt -o out.csv
"""

import argparse
import csv
import datetime as dt
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oscr_xlsx_to_csv import (OUT_FIELDS, title_case, county_for, birthday_from,  # noqa: E402
                               normalize_city)

OPP_RE = re.compile(r"^OPP-\d+$", re.I)
DATE_RE = re.compile(r"^[A-Z][a-z]{2}\s+\d{1,2},\s*\d{4}$")
ZIP_RE = re.compile(r"^\d{5}$")
PHONE_RE = re.compile(r"^\+?1?[\s.\-()]*\d{3}[\s.\-()]*\d{3}[\s.\-]*\d{4}$")
AGE_RE = re.compile(r"^\d{1,3}$")
MONTH_RE = re.compile(r"^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$", re.I)

# Lines that are grid furniture, not data.
NOISE = {"total rows:", "fields", "density", "default view", "# of times disp.",
         "last disp. date", "days assigned to owner", "last name", "first name",
         "latest disp.", "age", "birth month", "lead source", "campaign",
         "primary phone:", "city", "zip code", "street", "orig date",
         "oscr lead id"}


def us_date(s):
    try:
        return dt.datetime.strptime(re.sub(r"\s+", " ", s.strip()), "%b %d, %Y").date().isoformat()
    except ValueError:
        return ""


def parse(text, today=None):
    today = today or dt.date.today()
    lines = [ln.strip() for ln in text.splitlines()]

    # Drop the header block, but only where it appears BEFORE any record — the
    # word "Fields" is also a real surname in this data.
    first_opp = next((i for i, ln in enumerate(lines) if OPP_RE.match(ln)), None)
    if first_opp is None:
        return []
    cleaned = []
    for i, ln in enumerate(lines):
        if not ln:
            continue
        if i < first_opp and ln.lower() in NOISE:
            continue
        cleaned.append(ln)

    # Split into records at each OSCR id (the id ends its record).
    records, cur = [], []
    for ln in cleaned:
        cur.append(ln)
        if OPP_RE.match(ln):
            records.append(cur)
            cur = []

    out = []
    for rec in records:
        t = list(rec)
        oscr_id = t.pop()                      # OPP-...
        orig_date = t.pop() if t and DATE_RE.match(t[-1]) else ""
        street = t.pop() if t else ""
        zip5 = t.pop() if t and ZIP_RE.match(t[-1]) else ""
        city = normalize_city(t.pop()) if t else ""

        # Walk back over the optional "Do not call" marker and phone.
        dnc, phone = False, ""
        while t:
            tail = t[-1]
            if tail.lower().replace(" ", "") == "donotcall":
                dnc = True
                t.pop()
            elif PHONE_RE.match(tail) and not phone:
                phone = t.pop()
            else:
                break

        campaign = t.pop() if t else ""
        lead_source = t.pop() if t else ""
        birth_month = t.pop() if t and MONTH_RE.match(t[-1]) else ""
        age = t.pop() if t and AGE_RE.match(t[-1]) else ""
        latest_disp = t.pop() if t else ""
        first = t.pop() if t else ""
        last = t.pop() if t else ""
        # Anything still in t is days-assigned / disp-count / last-disp-date.
        last_disp_date = ""
        for leftover in t:
            if DATE_RE.match(leftover):
                last_disp_date = us_date(leftover)

        out.append({
            "OSCR lead ID": oscr_id,
            "Name": f"{title_case(first)} {title_case(last)}".strip(),
            "Primary phone": phone,
            "Street": title_case(street),
            "City": city,
            "State": "NC",
            "Zip code": zip5,
            "County": county_for(city),
            "Birthday": birthday_from(birth_month, age or 64, today),
            "Lead source": lead_source or "Turning 65",
            "Latest disp.": latest_disp,
            "Last disp. date": last_disp_date,
            "Phone status": "DNC" if dnc else "",
            "Notes": f"Campaign {campaign}" if campaign else "",
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("txt")
    ap.add_argument("-o", "--out")
    a = ap.parse_args()
    rows = parse(open(a.txt, encoding="utf-8").read())
    out_path = a.out or os.path.splitext(a.txt)[0] + "_clean.csv"
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=OUT_FIELDS)
        w.writeheader()
        w.writerows(rows)
    dnc = sum(1 for r in rows if r["Phone status"] == "DNC")
    nophone = sum(1 for r in rows if not r["Primary phone"])
    pobox = sum(1 for r in rows if r["Street"].lower().startswith("po box"))
    print(f"  records parsed     {len(rows)}")
    print(f"  DNC flagged        {dnc}")
    print(f"  no phone           {nophone}")
    print(f"  PO box (unknockable) {pobox}")
    print(f"  missing birthday   {sum(1 for r in rows if not r['Birthday'])}")
    print(f"  towns              {', '.join(sorted({r['City'] for r in rows}))}")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
