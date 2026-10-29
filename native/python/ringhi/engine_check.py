"""Explicit installed-engine diagnostic. Never enumerates or opens device ports."""
import concurrent.futures
import json
import time
from pathlib import Path
from .esp import preflight
from .storage import Cancel


def run(output):
    start = time.monotonic()
    result = {'portAccess': False, 'attempts': 8, 'parallelWorkers': 4}
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: preflight(Cancel()), range(8)))
        result['passed'] = True
    except Exception as exc:
        result.update(passed=False, error=str(exc))
    result['seconds'] = round(time.monotonic() - start, 2)
    path = Path(output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return 0 if result['passed'] else 1
