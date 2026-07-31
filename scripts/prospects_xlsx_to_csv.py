#!/usr/bin/env python3
"""Convert the prospect sheet and the business tracker's pipeline into CSVs.

    python scripts/prospects_xlsx_to_csv.py OUTDIR "prospect_sheet.xlsx" "Business Tracker.xlsx"

Two different objects, so two files out:

  prospects.csv  Everyone who graduated from lead to real prospect. Carries the
                 email (the CRM has almost none), the spouse, what was said,
                 and where it was left. Some are not T65 leads at all — out of
                 state, financial-advisory, referrals — so some will be new.

  pipeline.csv   The people Christian and Will have actually sat with. Each one
                 has an opportunity, an owner and a next action, which is a
                 lead_action in CRM terms. There is NO PHONE on this sheet, so
                 matching is by name and has to be conservative.

Both sheets are hand-kept, so the date columns hold prose ("Late Feb. - Early
Mar.", "stay in touch"). Prose stays prose and goes to the notes; only a real
date becomes a date.
"""

import csv
import os
import re
import sys
from datetime import datetime, timedelta

import openpyxl

TODAY = datetime.now()

# The pipeline sheet buckets follow-ups rather than dating them. These are the
# midpoints a person means by each phrase, so the action lands in the right week.
BUCKET_DAYS = {
    "overdue": 0,
    "this week": 3,
    "this month": 14,
    "next 1-2 mo": 45,
    "aep / future": None,   # AEP opens October 15
}

ACTION_TYPE = {
    "call": "Call",
    "email": "Email",
    "text": "Text",
    "mail": "Mail",
    "follow-up appt": "Other",
    "door knock": "Door Knock",
}


def clean(v):
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d")
    return re.sub(r"\s+", " ", str(v)).strip()


def real_date(v):
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d")
    s = clean(v)
    m = re.match(r"^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$", s)
    if not m:
        return ""
    mo, d, y = m.groups()
    y = int(y) + (2000 if y and int(y) < 100 else 0) if y else TODAY.year
    try:
        return datetime(int(y), int(mo), int(d)).strftime("%Y-%m-%d")
    except ValueError:
        return ""


def bucket_due(bucket):
    key = clean(bucket).lower()
    if key not in BUCKET_DAYS:
        return (TODAY + timedelta(days=14)).strftime("%Y-%m-%d 10:00")
    days = BUCKET_DAYS[key]
    if days is None:
        aep = datetime(TODAY.year, 10, 15, 10, 0)
        if aep < TODAY:
            aep = datetime(TODAY.year + 1, 10, 15, 10, 0)
        return aep.strftime("%Y-%m-%d %H:%M")
    return (TODAY + timedelta(days=days)).strftime("%Y-%m-%d 10:00")


def read_prospects(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb["Sheet1"] if "Sheet1" in wb.sheetnames else wb.worksheets[0]
    rows = [r for r in ws.iter_rows(min_row=1, values_only=True)
            if r and any(c not in (None, "") for c in r[:9])]
    hdr = [clean(c) for c in rows[0][:9]]
    idx = {h: i for i, h in enumerate(hdr) if h}
    out = []
    for r in rows[1:]:
        g = lambda k: clean(r[idx[k]]) if k in idx and idx[k] < len(r) else ""
        name = g("Client name")
        if not name:
            continue
        # "Diane Barber=BOOKED" is a name plus a flag someone typed inline.
        booked = bool(re.search(r"=\s*BOOKED", name, re.I))
        name = re.sub(r"\s*=\s*BOOKED\s*$", "", name, flags=re.I).strip()
        out.append({
            "Name": name,
            "Phone": g("Client ph#"),
            "Email": g("email"),
            "State": g("state"),
            "Lead source": g("Lead"),
            "Spouse": g("spouse"),
            "Follow up": g("follow up time/date"),
            "Follow up date": real_date(g("follow up time/date")),
            "Notes": g("notes"),
            "Results": g("Results"),
            "Booked": "yes" if booked else "",
        })
    wb.close()
    return out


def read_pipeline(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = next((s for s in wb.sheetnames if "Pipeline" in s), wb.sheetnames[0])
    ws = wb[sheet]
    rows = [r for r in ws.iter_rows(min_row=1, values_only=True)
            if r and any(c not in (None, "") for c in r)]
    hdr, out = None, []
    for r in rows:
        vals = [clean(c) for c in r]
        if "Client / Contact" in vals:
            hdr = vals
            continue
        if not hdr:
            continue
        idx = {h: i for i, h in enumerate(hdr) if h}
        g = lambda k: vals[idx[k]] if k in idx and idx[k] < len(vals) else ""
        if not g("Client / Contact"):
            continue
        at = ACTION_TYPE.get(g("Action Type").lower(), "Other")
        who = g("Assigned To")
        out.append({
            "Name": g("Client / Contact"),
            "Bucket": g("Follow-Up Date"),
            "Due": bucket_due(g("Follow-Up Date")),
            "Opportunity": g("Opportunity"),
            "Source": g("Referred By / Source"),
            "Status": g("Status"),
            "Next action": g("Next Action"),
            "Action type": at,
            "Assigned to": "Either" if who.lower() in ("both", "") else who,
            "Notes": g("Notes"),
        })
    wb.close()
    return out


def write(path, rows, fields):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def main():
    if len(sys.argv) < 4:
        raise SystemExit("Usage: prospects_xlsx_to_csv.py OUTDIR prospect_sheet.xlsx business_tracker.xlsx")
    outdir, prospect_path, pipeline_path = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(outdir, exist_ok=True)

    p = read_prospects(prospect_path)
    write(os.path.join(outdir, "prospects.csv"), p,
          ["Name", "Phone", "Email", "State", "Lead source", "Spouse",
           "Follow up", "Follow up date", "Notes", "Results", "Booked"])
    print(f"prospects: {len(p)} people, {sum(1 for x in p if x['Email'])} with an email, "
          f"{sum(1 for x in p if x['Booked'])} marked booked, "
          f"{sum(1 for x in p if not x['Phone'])} with no phone")

    q = read_pipeline(pipeline_path)
    write(os.path.join(outdir, "pipeline.csv"), q,
          ["Name", "Bucket", "Due", "Opportunity", "Source", "Status",
           "Next action", "Action type", "Assigned to", "Notes"])
    print(f"pipeline:  {len(q)} people you've sat with, "
          f"{sum(1 for x in q if x['Action type'] == 'Other')} follow-up appointments")


if __name__ == "__main__":
    main()
