"""Plan-only R35 photo UI candidate. Current local gate blocks paid execution."""
import argparse
import json
from .r35_plan import PLAN


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    if not args.execute:
        print(json.dumps(PLAN, indent=2))
        return 0
    # Retain the established approval boundary, but approval alone cannot make
    # an incomplete pack executable. No client construction/key read follows.
    from .local_e2e import _require_live_approval
    _require_live_approval()
    raise SystemExit("R35 local gate blocked: no approved photo or executable Live UI pack")


if __name__ == "__main__":
    raise SystemExit(main())
