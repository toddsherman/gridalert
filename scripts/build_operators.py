"""Build data/operators.json: which grid operators serve each utility, by state.

Takes EIA-861's Sales_Ult_Cust file, the one table that gives a balancing authority for
each utility in each state. Only operators with notices GridAlert can read are kept.

usage: python3 scripts/build_operators.py <path to Sales_Ult_Cust_2025.xlsx>
"""
import json
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

SHEET = 'xl/worksheets/sheet1.xml'
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
OPERATORS = {'CISO', 'ISNE', 'MISO', 'NYIS', 'PJM', 'SWPP'}
HEADER_ROWS = 3
COLUMNS = {'B': 'utility', 'G': 'state', 'I': 'ba'}


def rows(path):
    with zipfile.ZipFile(path) as z:
        strings = [''.join(t.text or '' for t in si.iter(f'{NS}t')) for si in ET.fromstring(z.read('xl/sharedStrings.xml'))]
        for row in ET.fromstring(z.read(SHEET)).iter(f'{NS}row'):
            out = {}
            for cell in row:
                column = ''.join(c for c in cell.get('r') if c.isalpha())
                value = cell.find(f'{NS}v')
                if column in COLUMNS and value is not None:
                    out[COLUMNS[column]] = strings[int(value.text)] if cell.get('t') == 's' else value.text
            yield out


def main(path):
    known = {str(u['eiaId']) for u in json.loads(Path('data/utilities.json').read_text())}
    operators = {}
    for row in list(rows(path))[HEADER_ROWS:]:
        if row.get('ba') in OPERATORS and row.get('utility') in known:
            states = operators.setdefault(row['utility'], {})
            states[row['state']] = sorted({*states.get(row['state'], []), row['ba']})
    ordered = {u: operators[u] for u in sorted(operators, key=int)}
    Path('data/operators.json').write_text(json.dumps(ordered, indent=0) + '\n')
    print(f'{len(ordered)} of {len(known)} utilities have a readable operator')


if __name__ == '__main__':
    main(sys.argv[1])
