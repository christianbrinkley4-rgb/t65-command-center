"""
Convert a T65 neighborhood/mailing-list .xlsx report into the same clean CSV
that scripts/import-oscr-csv.mjs imports.

This is a DIFFERENT shape from the OSCR "Turning 65" export (see
oscr_xlsx_to_csv.py). Its traps:

  1. No header row at all — data starts on row 0.
  2. Column 3 is overloaded: it holds EITHER a phone number OR the literal
     "DoNotCall". Treat it as a phone column and you import "DoNotCall" as
     somebody's number; ignore it and you lose the do-not-call flag.
  3. Every lead is followed by a "Details For Zip Code:" row and a blank row.
  4. Names arrive "LAST, FIRST" in caps.
  5. City is spelled both "PLEASANT GDN" and "PLEASANT GARDEN", which would
     split one town into two entries in the Door Knock town filter.

Columns: 0 name, 1 street, 2 "CITY, ST ZIP", 3 phone-or-DoNotCall,
         4 birthday, 5 age.

Usage:
    python scripts/t65_list_xlsx_to_csv.py "report.xlsx" [-o out.csv] [--source NAME]
"""

import argparse
import csv
import datetime as dt
import os
import re
import sys

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required:  pip install openpyxl")

from oscr_xlsx_to_csv import OUT_FIELDS, title_case, county_for, as_date, normalize_city

def flip_name(v):
    """'JOHNSON, JOHN' -> 'John Johnson'. Handles a missing comma."""
    s = str(v or "").strip()
    if not s:
        return ""
    if "," in s:
        last, _, first = s.partition(",")
        return f"{title_case(first)} {title_case(last)}".strip()
    return title_case(s)


def split_city_line(v):
    """'PLEASANT GDN, NC 27313-8001' -> ('Pleasant Garden', 'NC', '27313')."""
    s = str(v or "").strip()
    city, _, rest = s.partition(",")
    m_zip = re.search(r"\b(\d{5})", rest)
    m_st = re.search(r"\b([A-Z]{2})\b", rest.upper())
    return normalize_city(city), (m_st.group(1) if m_st else "NC"), (m_zip.group(1) if m_zip else "")


PHONE_RE = re.compile(r"\d{3}\D*\d{3}\D*\d{4}")

MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
               "July", "August", "September", "October", "November", "December"]


def t65_source(birthday):
    """Which list this person belongs on: "T65 October", from their own birthday.

    Where the report came from is not a category. A neighborhood report is how
    the names were pulled, not something true about the people in it — and the
    app only recognises "T65 <Month>" or "General leads" anyway, so a
    "Burlington Neighborhood report" source would create a list that can never
    narrow anything and would hide these people from the month they actually
    turn 65. One report routinely spans several months (this one has May and
    October on the first four rows), so the label has to be per-lead.
    """
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(birthday or ""))
    if not m:
        return "General leads"
    month = int(m.group(2))
    return f"T65 {MONTH_NAMES[month - 1]}" if 1 <= month <= 12 else "General leads"


def convert(path, out_path=None, source_label=""):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rows = list(wb.worksheets[0].iter_rows(values_only=True))

    out, seen = [], set()
    stats = {"leads": 0, "dnc": 0, "phones": 0, "no_phone": 0, "dupes": 0, "noise": 0}

    for r in rows:
        name_cell = str(r[0] or "").strip()
        if not name_cell:
            continue
        # The per-ZIP header row. Matched anywhere in the cell rather than as a
        # prefix: the 27408 export produced "etails For Zip Code: 27408-3219"
        # with the leading D missing, which a startswith() check waved through
        # and imported as a person named "Etails For Zip Code".
        if "for zip code" in name_cell.lower():
            stats["noise"] += 1
            continue

        street = title_case(r[1] if len(r) > 1 else "")
        # A real record always has a street. This is the structural backstop for
        # whatever the next export mangles — a header, a footer, a page number,
        # a total. Without an address a row can't be knocked, can't be matched
        # to a parcel, and can't be deduped, so it has no way to be useful.
        if not street:
            stats["noise"] += 1
            continue

        stats["leads"] += 1
        city, state, zip5 = split_city_line(r[2] if len(r) > 2 else "")
        name = flip_name(name_cell)

        # Column 3 is a phone OR the do-not-call marker OR empty.
        raw3 = str(r[3] or "").strip() if len(r) > 3 else ""
        phone, dnc = "", False
        if raw3.lower().replace(" ", "") == "donotcall":
            dnc = True
            stats["dnc"] += 1
        elif PHONE_RE.search(raw3):
            phone = raw3
            stats["phones"] += 1
        if not phone:
            stats["no_phone"] += 1

        key = (name.lower(), street.lower())
        if key in seen:
            stats["dupes"] += 1
            continue
        seen.add(key)

        birthday = as_date(r[4] if len(r) > 4 else "")
        out.append({
            "OSCR lead ID": "",
            "Name": name,
            "Primary phone": phone,
            "Street": street,
            "City": city,
            "State": state,
            "Zip code": zip5,
            "County": county_for(city),
            "Birthday": birthday,
            # Filed by the month they turn 65, not by which report found them.
            "Lead source": source_label or t65_source(birthday),
            "Latest disp.": "",
            "Last disp. date": "",
            "Phone status": "DNC" if dnc else "",
            "Notes": "",
        })

    out_path = out_path or os.path.splitext(path)[0] + "_clean.csv"
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=OUT_FIELDS)
        w.writeheader()
        w.writerows(out)

    no_bday = sum(1 for r in out if not r["Birthday"])
    no_county = sum(1 for r in out if not r["County"])
    cities = sorted({r["City"] for r in out})
    print(f"Read {path}")
    print(f"  lead rows            {stats['leads']}")
    print(f"  'Details' filler     {stats['noise']} (skipped)")
    print(f"  duplicate name+addr  {stats['dupes']} (collapsed)")
    print(f"  with a phone         {stats['phones']}")
    print(f"  DoNotCall flagged    {stats['dnc']}")
    print(f"  no phone at all      {stats['no_phone']}  <- door-knock only")
    print(f"  unique leads out     {len(out)}")
    print(f"  missing birthday     {no_bday}")
    print(f"  county not derived   {no_county}")
    print(f"  towns                {', '.join(cities)}")
    print(f"Wrote {out_path}")
    return out_path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("-o", "--out")
    ap.add_argument("--source", default="", help="Lead source label, e.g. 'T65 Pleasant Garden'")
    a = ap.parse_args()
    convert(a.xlsx, a.out, a.source)
