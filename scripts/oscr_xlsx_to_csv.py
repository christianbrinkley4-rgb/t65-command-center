"""
Convert a raw OSCR "Turning 65" .xlsx export into a clean CSV the CRM can import.

Why this exists: the OSCR export is a rendered table, not a data file, and it has
three traps that silently corrupt a naive import.

  1. DNC lives on its own row. A flagged lead's phone cell renders as two lines
     (the number, then "Do not call"), and the second line becomes a separate
     row with only column 11 filled. It belongs to the lead ABOVE it. Drop those
     rows and 82% of this book imports as callable when it is not.
  2. Header rows repeat mid-file (pagination), so "Age"/"Lead source" show up as
     data values.
  3. Birth date is only a month name plus age 64. The year has to be derived, or
     every lead lands with no birthday and falls off the T65 radar.

Usage:
    python scripts/oscr_xlsx_to_csv.py "path/to/export.xlsx" [-o out.csv]
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

# Column positions in the OSCR "Turning 65" default view.
COL = {
    "disp_count": 1, "last_disp_date": 2, "days_assigned": 3, "last_name": 4,
    "first_name": 5, "latest_disp": 6, "age": 7, "birth_month": 8,
    "lead_source": 9, "campaign": 10, "phone": 11, "city": 12, "zip": 13,
    "street": 14, "orig_date": 15, "oscr_id": 16,
}

MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}

# Triad city -> county. County sharpens the parcel match for home values and
# drives the Power List county filter; the OSCR export doesn't carry it.
CITY_COUNTY = {
    "guilford": ["greensboro", "high point", "jamestown", "oak ridge", "summerfield",
                 "pleasant garden", "pleasant gdn", "colfax", "stokesdale", "sedalia",
                 "whitsett", "mc leansville", "mcleansville", "browns summit", "gibsonville",
                 "julian", "climax"],
    "alamance": ["burlington", "elon", "graham", "mebane", "haw river", "snow camp",
                 "swepsonville", "green level", "saxapahaw", "altamahaw", "ossipee"],
    "forsyth": ["winston salem", "winston-salem", "kernersville", "walkertown", "clemmons",
                "lewisville", "rural hall", "tobaccoville", "pfafftown", "belews creek"],
    "randolph": ["asheboro", "archdale", "randleman", "trinity", "liberty", "ramseur",
                 "franklinville", "seagrove", "sophia", "staley"],
    "rockingham": ["reidsville", "eden", "madison", "mayodan", "stoneville", "ruffin",
                   "wentworth"],
    "davidson": ["lexington", "thomasville", "denton", "welcome"],
    "chatham": ["siler city", "pittsboro", "goldston", "bear creek"],
    "orange": ["hillsborough", "efland", "cedar grove"],
    "caswell": ["yanceyville", "prospect hill"],
}
CITY_TO_COUNTY = {c: county.title() for county, cities in CITY_COUNTY.items() for c in cities}


def county_for(city):
    return CITY_TO_COUNTY.get(re.sub(r"\s+", " ", str(city or "").strip().lower()), "")


# Postal abbreviations that would otherwise split one town into two entries in
# the Door Knock town filter (and hide half the doors when you pick one).
CITY_ALIASES = {
    "pleasant gdn": "Pleasant Garden",
    "pleasant grdn": "Pleasant Garden",
    "winston-salem": "Winston Salem",
    "mcleansville": "Mc Leansville",
    "browns smt": "Browns Summit",
    "kernersvlle": "Kernersville",
    "summerfld": "Summerfield",
    "w salem": "Winston Salem",
    "high pt": "High Point",
}


def normalize_city(raw):
    c = re.sub(r"\s+", " ", str(raw or "").strip().lower())
    return CITY_ALIASES.get(c, title_case(c))


def title_case(v):
    """OSCR exports names in caps. 'MCDONALD' -> 'McDonald', "O'BRIEN" -> "O'Brien"."""
    s = str(v or "").strip()
    if not s:
        return ""
    out = []
    for word in s.split():
        w = word.capitalize()
        if w.lower().startswith("mc") and len(w) > 2:
            w = "Mc" + w[2:].capitalize()
        elif w.lower().startswith("o'") and len(w) > 2:
            w = "O'" + w[2:].capitalize()
        w = re.sub(r"-(\w)", lambda m: "-" + m.group(1).upper(), w)
        out.append(w)
    return " ".join(out)


def birthday_from(month_name, age, today):
    """
    Month name + age -> the birth date, day defaulted to the 1st (the IEP radar
    works in months). Age 64 with a birth month already past this year means they
    were born 64 years ago this year; a month still ahead means 65 years ago.
    """
    m = MONTHS.get(str(month_name or "").strip().lower()[:3])
    if not m:
        return ""
    try:
        age = int(age)
    except (TypeError, ValueError):
        return ""
    year = today.year - age if m <= today.month else today.year - age - 1
    return f"{year:04d}-{m:02d}-01"


def as_date(v):
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    s = str(v or "").strip()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}" if m else ""


OUT_FIELDS = ["OSCR lead ID", "Name", "Primary phone", "Street", "City", "State",
              "Zip code", "County", "Birthday", "Lead source", "Latest disp.",
              "Last disp. date", "Phone status", "Notes"]


def convert(path, out_path=None, today=None):
    today = today or dt.date.today()
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rows = list(wb.worksheets[0].iter_rows(values_only=True))

    def cell(r, key):
        i = COL[key]
        return r[i] if i < len(r) else None

    leads, order = {}, []
    stats = {"rows": 0, "headers_skipped": 0, "dnc_rows": 0, "dupes_in_file": 0, "no_id": 0}
    last_id = None

    for r in rows:
        if not any(v is not None for v in r):
            continue
        oscr_id = cell(r, "oscr_id")

        # Continuation row: only the phone column, carrying "Do not call".
        if not oscr_id:
            note = str(cell(r, "phone") or "").strip().lower()
            if note.startswith("do not call") and last_id:
                leads[last_id]["Phone status"] = "DNC"
                stats["dnc_rows"] += 1
            elif any(v is not None for v in r):
                stats["no_id"] += 1
            continue

        oscr_id = str(oscr_id).strip()
        # Repeated header row from pagination.
        if oscr_id.lower() == "oscr lead id" or str(cell(r, "age") or "").lower() == "age":
            stats["headers_skipped"] += 1
            last_id = None
            continue

        stats["rows"] += 1
        if oscr_id in leads:
            stats["dupes_in_file"] += 1
            last_id = oscr_id  # a later DNC line still applies
            continue

        city = normalize_city(cell(r, "city"))
        rec = {
            "OSCR lead ID": oscr_id,
            "Name": f'{title_case(cell(r, "first_name"))} {title_case(cell(r, "last_name"))}'.strip(),
            "Primary phone": str(cell(r, "phone") or "").strip(),
            "Street": title_case(cell(r, "street")),
            "City": city,
            "State": "NC",
            "Zip code": str(cell(r, "zip") or "").strip(),
            "County": county_for(city),
            "Birthday": birthday_from(cell(r, "birth_month"), cell(r, "age"), today),
            "Lead source": str(cell(r, "lead_source") or "").strip(),
            "Latest disp.": str(cell(r, "latest_disp") or "").strip(),
            "Last disp. date": as_date(cell(r, "last_disp_date")),
            "Phone status": "",
            "Notes": "",
        }
        campaign = str(cell(r, "campaign") or "").strip()
        disp_count = cell(r, "disp_count")
        bits = []
        if campaign:
            bits.append(f"Campaign {campaign}")
        if disp_count not in (None, "", "# of times disp."):
            bits.append(f"dispositioned {disp_count}x")
        rec["Notes"] = " · ".join(bits)
        leads[oscr_id] = rec
        order.append(oscr_id)
        last_id = oscr_id

    out_path = out_path or os.path.splitext(path)[0] + "_clean.csv"
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=OUT_FIELDS)
        w.writeheader()
        for k in order:
            w.writerow(leads[k])

    dnc = sum(1 for k in order if leads[k]["Phone status"] == "DNC")
    no_bday = sum(1 for k in order if not leads[k]["Birthday"])
    no_county = sum(1 for k in order if not leads[k]["County"])
    print(f"Read {path}")
    print(f"  lead rows            {stats['rows']}")
    print(f"  repeated headers     {stats['headers_skipped']} (skipped)")
    print(f"  duplicate IDs        {stats['dupes_in_file']} (collapsed)")
    print(f"  'Do not call' lines  {stats['dnc_rows']} -> attached to the lead above")
    print(f"  unique leads out     {len(order)}  ({dnc} DNC, {len(order)-dnc} callable)")
    print(f"  missing birthday     {no_bday}")
    print(f"  county not derived   {no_county}")
    print(f"Wrote {out_path}")
    return out_path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("-o", "--out")
    a = ap.parse_args()
    convert(a.xlsx, a.out)
