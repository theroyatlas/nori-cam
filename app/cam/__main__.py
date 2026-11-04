import argparse
import os
from types import SimpleNamespace
from .clients import MetaSpark, MetaImage, SamBox
from .pipeline import run


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--gift-id", required=True)
    args = parser.parse_args()
    try:
        result = run(args.gift_id, os.environ["WORKER_BASE"], os.environ["NORI_INGEST_TOKEN"],
                     SimpleNamespace(spark=MetaSpark(), image=MetaImage(), box=SamBox()))
    except Exception:
        # Even SDK exceptions may contain input or authentication details.
        return 1
    print(args.gift_id)
    return 0 if result["type"] == "gift_ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
