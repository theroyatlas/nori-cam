"""Preregistered finite natural waiting, with normal GET advancement only."""
import time
from . import local_e2e as r

VIRTUAL_HOURS = 12
MAX_STEP_MS = 5 * 60000
WALL_SECONDS = 180
MAX_ADVANCES = 4000


def wait_reflection(base, clock, rows, trail, observer):
    start = clock.get()
    stop = start + VIRTUAL_HOURS * 3600000
    deadline = time.monotonic() + WALL_SECONDS
    advances = []
    outcome = {"start": start, "virtual_stop": stop, "wall_limit_s": WALL_SECONDS,
               "max_step_ms": MAX_STEP_MS, "max_advances": MAX_ADVANCES, "advances": advances}
    try:
        for _ in range(MAX_ADVANCES):
            found = r._reflect_dispatched()
            if found:
                outcome["dispatch"] = found
                return found
            now = clock.get()
            if now >= stop or time.monotonic() >= deadline:
                break
            # Visit all stored boundaries, including starts of sleep triggers.
            boundaries = rows(f"SELECT start_at,end_at FROM segments WHERE superseded_at IS NULL AND end_at>{now}")
            future = [s[k] for s in boundaries for k in ("start_at", "end_at") if s[k] > now]
            target = min(stop, now + MAX_STEP_MS, min(future, default=stop))
            clock.set(target)
            r._fetch_cam(base)
            advances.append({"from": now, "to": target})
            observer.stage("stage_reflect_wait")
        outcome["failure"] = "no dispatch within preregistered natural window"
        return None
    finally:
        import json
        (observer.out / "reflection-clock.json").write_text(json.dumps(outcome, indent=2), encoding="utf-8")
