"""Reviewable one-photo LIVE candidate. Default only prints a plan, reads no key.

Execution still needs explicit user approval, the existing live gate, a fresh
isolated local Worker/D1, and --execute. This does not deploy or start a Worker.
"""
import argparse
import json
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit

from . import clients, local_e2e, wake

PHOTO_SHA256 = "d669659f52e9707d1cb143faf6a7c89573dad44c1aa3d106f2bcb37ea74d01f1"
TOKEN_CAPS = {"muse-spark-1.3": 4096, "muse-image-1.0": 2048, "muse-wonder-1.0": 2048}
PLAN = {"executed": False, "input": "one existing public CC0 steaming-mug photo",
        "photo_sha256": PHOTO_SHA256, "calls_per_model_max": {model: 1 for model in TOKEN_CAPS},
        "max_output_tokens": TOKEN_CAPS, "request_timeout_s": 120, "provider_retries": 0,
        "overall_minutes": 15, "spend_stop_threshold_usd": 0.50,
        "money_limit": "local reservations/post-call accounting, not a hard provider billing cap",
        "worker": "isolated loopback Worker/D1 only; Spark reactions and browse OFF; reflect ON",
        "acceptance": "all six original judge stages + M2 pass + persisted cited Wonder reflection",
        "expected_limit": "captured mug has no world-change effect; a fresh model may still fail stage 5"}


class BoundedResponses:
    def __init__(self, responses, deadline):
        self.inner = responses
        self.deadline = deadline
        self.called = set()

    def create(self, **kwargs):
        model = kwargs.get("model")
        if model not in TOKEN_CAPS or model in self.called:
            raise RuntimeError("candidate model/call-count cap")
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("candidate overall deadline")
        self.called.add(model)  # A failed/uncertain request consumes its one call too.
        kwargs.update(max_output_tokens=TOKEN_CAPS[model], timeout=min(120, remaining))
        return self.inner.create(**kwargs)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--photo")
    parser.add_argument("--out")
    parser.add_argument("--registration")
    parser.add_argument("--worker-base", default="http://127.0.0.1:8789")
    args = parser.parse_args(argv)
    if not args.execute:
        print(json.dumps(PLAN, indent=2))
        return 0
    local_e2e._require_live_approval()
    base = urlsplit(args.worker_base)
    if base.scheme != "http" or base.hostname != "127.0.0.1" or not base.port or base.port == 8798:
        raise SystemExit("candidate requires its own IPv4 loopback Worker port")
    if not all((args.photo, args.out, args.registration)):
        raise SystemExit("--execute requires --photo, --out and --registration")
    if local_e2e._sha256_file(Path(args.photo)) != PHOTO_SHA256:
        raise SystemExit("candidate input does not match the approved public photo")
    # Verify switches before constructing any provider client or reading a key.
    config_path = local_e2e._require_env("NORI_CAM_LOCAL_CONFIG")
    local_e2e._require_env("NORI_CAM_LOCAL_PERSIST")
    config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    expected = {"CAM_LOCAL_PIPELINE": "1", "CAM_SPARK_ENABLED": "0",
                "CAM_BROWSE_ENABLED": "0", "CAM_REFLECT_ENABLED": "1", "CAM_DAILY_USD": "0.50"}
    if config.get("triggers") or any(config.get("vars", {}).get(k) != v for k, v in expected.items()):
        raise SystemExit("candidate config must match reviewed switches/budget and have no cron")
    sdk = clients.meta_client().with_options(max_retries=0, timeout=120)
    guarded = SimpleNamespace(responses=BoundedResponses(sdk.responses, time.monotonic() + 15 * 60))
    spark, image, wonder = clients.MetaSpark, clients.MetaImage, wake.MetaWonder
    with patch.object(clients, "MetaSpark", lambda: spark(client=guarded)), \
         patch.object(clients, "MetaImage", lambda: image(client=guarded)), \
         patch.object(wake, "MetaWonder", lambda: wonder(client=guarded)):
        return local_e2e.main(["--live", "--fresh", "--photo", args.photo, "--out", args.out,
                               "--registration", args.registration, "--worker-base", args.worker_base,
                               "--max-usd", "0.50", "--max-minutes", "15"])


if __name__ == "__main__":
    raise SystemExit(main())
