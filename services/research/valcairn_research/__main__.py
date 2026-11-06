"""Read one JSON object from stdin and write collected pages to stdout.

Extra keys are dropped, so a secret in the payload is not echoed. A bad payload
exits non-zero. A refused URL is a page with status failed, not a process error.
"""

import json
import sys

from valcairn_research.fetch import collect


def main():
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.stdout.write(json.dumps({'error': 'The worker expected one JSON object on stdin.'}))
        return 2
    if not isinstance(payload, dict):
        sys.stdout.write(json.dumps({'error': 'The worker expected one JSON object.'}))
        return 2
    safe = {
        'question': payload.get('question') if isinstance(payload.get('question'), str) else '',
        'urls': payload.get('urls') if isinstance(payload.get('urls'), list) else [],
        'search': 'wikimedia' if payload.get('search') == 'wikimedia' else 'none',
        'limits': payload.get('limits') if isinstance(payload.get('limits'), dict) else {},
    }
    json.dump(collect(safe), sys.stdout, ensure_ascii=True)
    sys.stdout.write('\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
