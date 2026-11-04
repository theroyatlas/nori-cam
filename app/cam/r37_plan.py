"""Plan only; no provider/client/key/process access."""
PLAN = {"executed": False, "status": "blocked_pending_two_complete_r37_local_controls", "execute_command": None,
        "approval_required": True, "input": None,
        "models_max_calls": {"muse-spark-1.3": 1, "muse-image-1.0": 1, "muse-wonder-1.0": 1},
        "max_output_tokens": {"muse-spark-1.3": 4096, "muse-image-1.0": 2048, "muse-wonder-1.0": 2048},
        "provider_retries": 0, "request_timeout_s": 120, "overall_minutes": 15, "spend_stop_threshold_usd": 0.50,
        "money_limit": "local reservation/accounting stop, not provider hard billing cap",
        "ui_path": "file selection -> multipart POST -> processing -> terminal -> world refresh",
        "next_action": "require two frozen local controls with batch proof, causal diagnostic, original stages1-5 and exact Mock Wonder citation/intent/cost"}
