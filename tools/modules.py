#!/usr/bin/env python3
"""Map the modules inside local-connections/main.js.

The bundle is esbuild output: every module is preceded by a `// <path>` comment
line, and the fork's own additions by a `// ===== ... =====` banner. Those
comment lines are the section boundaries, and they are how you navigate and cut
safely (a module body runs from its header to the next header).

  tools/modules.py                  all sections, in file order
  tools/modules.py -s               all sections, largest first
  tools/modules.py search           only sections whose path matches "search"
  tools/modules.py -s smart-blocks  matching sections, largest first

Output: start-end, line count, section name.
"""
import os
import re
import sys

MAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    '..', 'local-connections', 'main.js')

HDR = re.compile(r'^// ((?:node_modules/|src/|releases/|smart_env|[a-z_\-]+/)[^\s]*'
                 r'\.(?:js|css|json|md))$')

args = [a for a in sys.argv[1:]]
by_size = '-s' in args
if by_size:
    args.remove('-s')
needle = args[0].lower() if args else None

lines = open(MAIN, encoding='utf-8').read().split('\n')
sections = []
cur = ('<preamble>', 0)
for i, l in enumerate(lines):
    m = HDR.match(l)
    if m or l.startswith('// ===== '):
        sections.append((cur[0], cur[1], i))
        cur = ((m.group(1) if m else l.strip('/ =').strip()), i)
sections.append((cur[0], cur[1], len(lines)))

rows = [(n, s, e) for n, s, e in sections if not needle or needle in n.lower()]
rows.sort(key=lambda x: -(x[2] - x[1]) if by_size else x[1])

total = 0
for n, s, e in rows:
    total += e - s
    print(f'{s+1:6d}-{e:<6d} {e-s:6d}  {n}')
print(f'{"":13} {total:6d}  TOTAL in {len(rows)} section(s) '
      f'of {len(sections)} ({len(lines)} lines in file)')
