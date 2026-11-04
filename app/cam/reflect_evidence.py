"""Private, external-state reflection receipts. Never record request headers or keys."""
import json
import math
import re
import hashlib
from pathlib import Path


def safe_error(error, secrets=()):
    message = str(error)
    for secret in secrets:
        if secret:
            message = message.replace(secret, '[REDACTED]')
    message = re.sub(r'(?i)bearer\s+[^\s\"\',;]+', 'Bearer [REDACTED]', message)
    message = re.sub(r'(?i)((?:api[ _-]?key(?:\s+provided)?|token|authorization|password)\s*[=:]\s*)[^\s,;]+', r'\1[REDACTED]', message)
    message = re.sub(r'\bsk-[A-Za-z0-9_-]+', '[REDACTED]', message)
    return ' '.join(message.split())[:500]


def evidence_path(state, experience_id):
    # Experience ids contain colons, which are not portable Windows filenames.
    name = re.sub(r'[^A-Za-z0-9_.-]', '_', experience_id)
    if not name:
        raise ValueError('invalid evidence experience id')
    if len(name) > 160:
        name = name[:140] + '-' + hashlib.sha256(experience_id.encode()).hexdigest()[:16]
    return Path(state) / 'evidence' / ('reflect-' + name + '.json')


def save_evidence(state, experience_id, evidence):
    path = evidence_path(state, experience_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.json.tmp')
    def serializable(value):
        # Preserve malformed numeric outputs without producing invalid JSON or losing
        # the whole receipt. The untouched raw output_text remains in the response.
        if isinstance(value, float) and not math.isfinite(value):
            return {'invalid_nonfinite_number': str(value)}
        if isinstance(value, dict): return {k: serializable(v) for k, v in value.items()}
        if isinstance(value, list): return [serializable(v) for v in value]
        return value
    temporary.write_text(json.dumps(serializable(evidence), ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    temporary.replace(path)
    return path
