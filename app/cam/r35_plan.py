"""Default-safe R35 plan: no clients, keys, processes or network at import/print."""
PLAN = {"executed": False, "status": "blocked_local_v2_not_evaluable_and_reflection_timeout",
        "approval_required": True, "execute_command": None,
        "models_max_calls": {"muse-spark-1.3": 1, "muse-image-1.0": 1, "muse-wonder-1.0": 1},
        "provider_retries": 0, "request_timeout_s": 120, "overall_minutes": 15,
        "max_output_tokens": {"muse-spark-1.3": 4096, "muse-image-1.0": 2048, "muse-wonder-1.0": 2048},
        "spend_stop_threshold_usd": 0.50,
        "money_limit": "local reservation/accounting stop threshold; not provider hard billing cap",
        "input": None, "ui_path": "owner file selection -> real multipart POST -> processing -> terminal -> world refresh",
        "acceptance": "stages1-5 + exact effect/experience/Wonder + additive experience_causal_v2; retain original stage6 verdict",
        "local_result": {"new_ui_trials": 1, "v2": "NOT_EVALUABLE", "legacy_stage6": "FAIL",
                         "reflection": "timeout; zero reflect dispatch/model calls"},
        "blocked_reason": "lazy read-time settlement combined target and another experience; no exact adjacent persisted sample",
        "next_action": "new preregistered read-only batch-replay provenance path verified against persisted CAS state; no world writes; then repeat fixed control and reflection checks before selecting a public CC0 photo"}
