"""Default plan only; no client/key/process/network access or execution mode."""
import json
from pathlib import Path
PLAN={"executed":False,"status":"blocked_pending_two_complete_r38_controls","execute_command":None,
      "approval_required":True,"input":None,"models_max_calls":{"muse-spark-1.3":1,"muse-image-1.0":1,"muse-wonder-1.0":1},
      "max_output_tokens":{"muse-spark-1.3":4096,"muse-image-1.0":2048,"muse-wonder-1.0":2048},
      "provider_retries":0,"request_timeout_s":120,"overall_minutes":15,"spend_stop_threshold_usd":0.50,
      "money_limit":"local reservation/accounting stop threshold; NOT provider hard billing cap",
      "ui_path":"actual owner file selection -> multipart POST -> processing -> terminal -> world refresh"}


def load_plan():
    candidate=Path(__file__).resolve().parents[2]/'docs/research/spikes/r38-engineering/LIVE-CANDIDATE.json'
    if candidate.exists():
        plan=json.loads(candidate.read_text(encoding='utf-8'))
        if plan.get('executed') is not False or plan.get('execute_command') is not None:
            raise ValueError('candidate must remain plan-only')
        return plan
    return PLAN
