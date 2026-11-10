"""Normalize DOE's disturbance reports into data/doe417.json for the cause backtest.

Keeps reports of 50,000 or more customers from the annual summaries at
https://doe417.pnnl.gov/summaries/. Files from 2024 on are .xlsx, older ones .xls.

usage: python3 scripts/build_doe417.py <dir with the downloaded summaries>
requires: xlrd
"""
import json
import re
import sys
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

import xlrd

MIN_CUSTOMERS = 50_000
YEARS = range(2019, 2026)


def read_xlsx(path):
    book = zipfile.ZipFile(path)
    strings = []
    if 'xl/sharedStrings.xml' in book.namelist():
        for si in re.findall(r'<si>(.*?)</si>', book.read('xl/sharedStrings.xml').decode(), re.S):
            strings.append(''.join(re.findall(r'<t[^>]*>(.*?)</t>', si, re.S)))
    sheet = sorted(n for n in book.namelist() if n.startswith('xl/worksheets/sheet'))[0]
    rows = []
    for row in re.findall(r'<row[^>]*>(.*?)</row>', book.read(sheet).decode(), re.S):
        cells = {}
        for ref, attrs, body in re.findall(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', row, re.S):
            value = re.search(r'<v>(.*?)</v>', body or '', re.S)
            inline = re.search(r'<t[^>]*>(.*?)</t>', body or '', re.S)
            text = value.group(1) if value else inline.group(1) if inline else ''
            if 't="s"' in attrs and value:
                text = strings[int(text)]
            cells[ref] = text.replace('&amp;', '&').strip()
        width = max((column_index(c) for c in cells), default=-1) + 1
        rows.append([cells.get(column_name(i), '') for i in range(width)])
    return rows


def column_index(name):
    index = 0
    for ch in name:
        index = index * 26 + ord(ch) - 64
    return index - 1


def column_name(index):
    name = ''
    index += 1
    while index:
        index, rest = divmod(index - 1, 26)
        name = chr(65 + rest) + name
    return name


def read_xls(path):
    sheet = xlrd.open_workbook(path, logfile=sys.stderr).sheet_by_index(0)
    return [[str(c.value).strip() for c in sheet.row(i)] for i in range(sheet.nrows)]


def number(value):
    try:
        return int(float(str(value).replace(',', '')))
    except ValueError:
        return None


def clock(value):
    """Times are '09:30 AM' from 2024 on and a fraction of a day before that."""
    text = str(value).strip()
    for pattern in ('%I:%M %p', '%H:%M'):
        try:
            return datetime.strptime(text, pattern).strftime('%H:%M')
        except ValueError:
            pass
    try:
        fraction = float(text)
    except ValueError:
        return None
    if 0 <= fraction < 1:
        minutes = round(fraction * 1440)
        return f'{minutes // 60:02d}:{minutes % 60:02d}'
    return None


def day(value):
    """A date string, or an Excel serial in a few older rows."""
    text = str(value).strip()
    try:
        return datetime.strptime(text, '%m/%d/%Y').strftime('%Y-%m-%d')
    except ValueError:
        pass
    try:
        return (datetime(1899, 12, 30) + timedelta(days=float(text))).strftime('%Y-%m-%d')
    except ValueError:
        return None


def main(folder):
    reports = []
    for year in YEARS:
        path = Path(folder) / (f'{year}.xlsx' if year >= 2024 else f'{year}.xls')
        rows = read_xlsx(path) if year >= 2024 else read_xls(path)
        at = next(i for i, r in enumerate(rows) if any('Customers' in c for c in r) and any('Event' in c for c in r))
        head = rows[at]
        col = lambda pattern: next(i for i, h in enumerate(head) if re.search(pattern, h, re.I))
        cols = dict(date=col('Date.*Began'), time=col('Time.*Began'), area=col('Area'), type=col('Event Type'), mw=col('Demand Loss'), customers=col('Customers'))
        for row in rows[at + 1:]:
            if len(row) <= cols['customers']:
                continue
            customers = number(row[cols['customers']])
            date = day(row[cols['date']])
            if customers is None or customers < MIN_CUSTOMERS or not date:
                continue
            reports.append(dict(date=date, time=clock(row[cols['time']]), area=row[cols['area']], type=row[cols['type']], customers=customers))
    Path('data/doe417.json').write_text(json.dumps(reports, indent=0) + '\n')
    print(f'{len(reports)} reports')


if __name__ == '__main__':
    main(sys.argv[1])
