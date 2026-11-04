"""Photo gift orchestration; HTTP, model clients, clock and sleep are injectable.

Worker contract: source is raw image bytes, not JSON. See the sample ingest.
No source images or model raw text are persisted or logged.
"""
import io
import json
import math
from pathlib import Path
import re
import time
from dataclasses import dataclass
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from PIL import Image
from .clients import CATEGORIES, CONTRACT_VERSION, HAZARD_KINDS, data_url
from .pixel import pixelize, room_palette
from .worker_base import normalize_worker_base

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "site/public"


def _client_message(exc):
    """Fixed message of our own client-side ValueError subclasses, else ''."""

    # Only ValueError subclasses defined in app.cam carry fixed code text, so
    # only those are safe to copy into step notes. Everything else keeps the
    # class-and-status-only note (never response text or data).
    if isinstance(exc, ValueError) and type(exc) is not ValueError:
        module = getattr(type(exc), "__module__", "") or ""
        if module == "app.cam" or module.startswith("app.cam."):
            try:
                message = str(exc)
            except Exception:
                return ""
            if message:
                return message[:120]
    return ""



def safe_error(exc):
    """Class name plus integer HTTP status only; never the message text."""
    status = getattr(exc, "status_code", None)
    if not isinstance(status, int):
        status = getattr(exc, "code", None) if isinstance(exc, HTTPError) else None
    name = type(exc).__name__
    return name if not isinstance(status, int) else f"{name} {status}"


class LegacyContractRefusal(ValueError):
    """Spark answer without the current prompt/contract version (fail closed)."""


class ContentSafetyRefusal(ValueError):
    """Photo refused for the public all-ages page."""


class UncertainSafetyRefusal(ValueError):
    """Content-safety answer missing or uncertain (fail closed)."""


class PersonRuleRefusal(ValueError):
    """Identifiable person: temporary product restriction (fail closed)."""


class HazardSpecError(ValueError):
    """Hazard attributes missing or inconsistent with declared parts/states."""


class InteractionContractError(ValueError):
    """Interaction breaks the ObjectCard/InteractionSpec contract."""


PART_KINDS = ("top", "front", "opening", "inside", "under", "handle",
              "pressable", "movable", "viewport")
SIDES = ("front", "back", "left", "right", "top")
CONTACT_PRIMITIVES = ("touch", "push", "carry", "drop", "climb", "sleep",
                      "set_object_state")
CONTACT_VALUES = CONTACT_PRIMITIVES + ("hold_pose",)


LEGACY_SAFETY_FIELDS = ("safe", "person_present")


def _refuse_legacy_fields(understood):
    """Refuse any answer or envelope carrying a legacy safety field (fail closed).

    Presence alone is a contract violation, whatever the value: a mixed
    contract must never be forwarded.
    """
    if not isinstance(understood, dict):
        return
    holders = [understood, understood.get("object_card")]
    for holder in holders:
        if isinstance(holder, dict) and any(f in holder for f in LEGACY_SAFETY_FIELDS):
            raise LegacyContractRefusal("legacy safety field")


def _refuse_safety(understood):
    """Enforce the versioned content-safety + product person rule (fail closed)."""
    if not isinstance(understood, dict) or understood.get("contract_version") != CONTRACT_VERSION:
        raise LegacyContractRefusal("legacy contract")
    _refuse_legacy_fields(understood)
    content = understood.get("content_safety")
    if not isinstance(content, dict) or "ok" not in content:
        raise UncertainSafetyRefusal("uncertain content safety")
    if content.get("ok") is not True:
        raise ContentSafetyRefusal("content safety refusal")
    if understood.get("identifiable_person_present") is not False:
        raise PersonRuleRefusal("product person rule")


def _check_hazards(card):
    """Hazards are explicit card attributes; a missing list is a refusal, not a pass."""
    hazards = card.get("hazards")
    if not isinstance(hazards, list) or len(hazards) > 8:
        raise HazardSpecError("hazards list required")
    declared = {p.get("kind") for p in card.get("parts", []) if isinstance(p, dict)}
    states = card.get("states", [])
    for hazard in hazards:
        if not isinstance(hazard, dict) or hazard.get("kind") not in HAZARD_KINDS:
            raise HazardSpecError("unknown hazard kind")
        parts = hazard.get("parts", [])
        hazard_states = hazard.get("states", [])
        if (not isinstance(parts, list) or not isinstance(hazard_states, list)
                or any(p not in PART_KINDS or p not in declared for p in parts)
                or any(s not in states for s in hazard_states)):
            raise HazardSpecError("hazard parts/states inconsistent")


def _check_candidate(card, candidate):
    """Static contract checks: declared parts, contact consistency, hazard overlap."""
    if not isinstance(candidate, dict):
        raise InteractionContractError("candidate shape")
    declared = {p.get("kind") for p in card.get("parts", []) if isinstance(p, dict)}
    states = card.get("states", [])
    approach = candidate.get("approach")
    if approach is not None and approach not in SIDES:
        raise InteractionContractError("unknown approach side")
    target = candidate.get("target_part")
    if target is not None and target not in declared:
        raise InteractionContractError("undeclared target part")
    contact = candidate.get("contact")
    steps = candidate.get("steps", [])
    if contact is not None:
        if contact != "none" and contact not in CONTACT_VALUES:
            raise InteractionContractError("unknown contact type")
        step_primitives = {s.get("p") for s in steps if isinstance(s, dict)}
        if contact == "none" and any(p in CONTACT_PRIMITIVES for p in step_primitives):
            raise InteractionContractError("contact steps with contact none")
        if contact in CONTACT_VALUES and contact not in step_primitives:
            raise InteractionContractError("contact type not in steps")
    allowed = candidate.get("allowed_states")
    if allowed is not None:
        if not isinstance(allowed, list) or any(s not in states for s in allowed):
            raise InteractionContractError("allowed states inconsistent")
    end_state = candidate.get("end_state")
    if end_state is not None and end_state not in states:
        raise InteractionContractError("unknown end state")
    if isinstance(allowed, list) and allowed and end_state is not None and end_state not in allowed:
        raise InteractionContractError("end state outside allowed states")
    for step in steps:
        if not isinstance(step, dict):
            continue
        if step.get("approach") is not None and step.get("approach") not in SIDES:
            raise InteractionContractError("unknown step approach side")
        part = step.get("part")
        if part is None:
            continue
        if step.get("p") == "move_to" and part not in declared and part in SIDES:
            continue
        if part not in declared:
            raise InteractionContractError("undeclared step part")
    # Hazard-vs-state refusal needs world state (current state, end state);
    # the Worker enforces it per candidate. The gate only requires the
    # hazard list itself to be present and consistent (see _check_hazards).


@dataclass
class Response:
    status: int
    body: bytes = b""
    headers: dict = None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_request(method, url, headers, body=None):
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with build_opener(NoRedirect).open(request, timeout=30) as response:
            data = response.read(5*1024*1024+1)
            if len(data) > 5*1024*1024:
                raise ValueError("response too large")
            return Response(response.status, data, dict(response.headers))
    except HTTPError as error:
        return Response(error.code, b"", dict(error.headers))


def schema_check(value, schema):
    """Validate the subset used by the checked-in schemas without a CI dependency."""
    kind = ("null" if value is None else "boolean" if isinstance(value, bool) else
            "object" if isinstance(value, dict) else "array" if isinstance(value, list) else
            "string" if isinstance(value, str) else "number" if isinstance(value, (int, float)) else "unknown")
    types = schema.get("type", [])
    if isinstance(types, str):
        types = [types]
    if types and kind not in types and not ("integer" in types and type(value) is int):
        raise ValueError("schema type")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError("schema enum")
    if kind == "number" and (not math.isfinite(value) or value < schema.get("minimum", -math.inf)
                             or value > schema.get("maximum", math.inf)):
        raise ValueError("schema range")
    if kind == "string" and not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", math.inf):
        raise ValueError("schema length")
    if kind == "array":
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", math.inf):
            raise ValueError("schema count")
        for child in value:
            schema_check(child, schema.get("items", {}))
    if kind == "object":
        if any(k not in value for k in schema.get("required", [])) or len(value) > schema.get("maxProperties", math.inf):
            raise ValueError("schema keys")
        for key, child in value.items():
            child_schema = schema.get("properties", {}).get(key, schema.get("additionalProperties", {}))
            if child_schema is False:
                raise ValueError("schema unknown key")
            schema_check(child, child_schema if isinstance(child_schema, dict) else {})


def run(gift_id, worker_base, token, clients, now_fn=time.monotonic, *,
        http_fn=http_request, sleep_fn=time.sleep, art_profile=None):
    """Return the acknowledged ingest payload; raise if failure cannot be reported.

    clients has spark/image/box attributes. Model costs on exceptions are conservative
    estimates, labelled cost_basis; only provider usage is described as actual usage.
    """
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", gift_id):
        raise ValueError("invalid gift id")
    if not token:
        raise ValueError("missing ingest token")
    worker_base = normalize_worker_base(worker_base)
    headers = {"Authorization": "Bearer " + token}
    steps = []
    step = "fetch_source"
    started = now_fn()
    current_model = None

    def record(ok, note=None):
        cost = float(getattr(current_model, "cost_usd", 0))
        if not math.isfinite(cost) or cost < 0:
            cost = 0.0
        seconds = max(0, now_fn()-started)
        entry = {"step": step, "model": getattr(current_model, "model", "local"),
                 "ok": ok, "seconds": seconds,
                 "ms": round(seconds*1000), "cost_usd": cost,
                 "cost_basis": getattr(current_model, "cost_basis", "local")}
        if note:
            entry["note"] = note
        steps.append(entry)

    def begin(name, model=None):
        nonlocal step, started, current_model
        step, started, current_model = name, now_fn(), model

    def send(payload):
        response = http_fn("POST", worker_base + "/api/ingest",
                           {**headers, "Content-Type": "application/json"},
                           json.dumps(payload, allow_nan=False).encode())
        if not 200 <= response.status < 300:
            raise RuntimeError("ingest unacknowledged")
        return payload

    try:
        waited = 0
        attempt = 0
        while True:
            if max(waited, now_fn()-started) > 120:
                raise TimeoutError("source consistency timeout")
            response = http_fn("GET", worker_base + "/api/gift/source/" + gift_id, headers)
            if now_fn()-started > 120:
                raise TimeoutError("source consistency timeout")
            if response.status == 200:
                break
            if response.status != 409:
                raise ValueError("source unavailable")
            elapsed = max(waited, now_fn()-started)
            delay = (5, 10, 20, 40, 40)[min(attempt, 4)]
            retry = next((v for k, v in (response.headers or {}).items() if k.lower() == "retry-after"), "0")
            try:
                retry = float(retry)
                if math.isfinite(retry):
                    delay = max(delay, retry)
            except (TypeError, ValueError):
                pass
            delay = min(delay, max(0, 120-elapsed))
            if delay <= 0:
                raise TimeoutError("source consistency timeout")
            sleep_fn(delay)
            waited += delay
            attempt += 1
        raw = response.body
        if len(raw) > 5*1024*1024:
            raise ValueError("source too large")
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in ("PNG", "JPEG") or image.width*image.height > 20_000_000:
                raise ValueError("invalid source image")
            image.load()
            mime = "image/png" if image.format == "PNG" else "image/jpeg"
        source_url = data_url(raw, mime)
        record(True)
        begin("understand", clients.spark)
        contracts = {"EXECUTOR": json.loads((PUBLIC / "cam/executor.json").read_text()),
                     "ObjectCard": json.loads((PUBLIC / "cam/schema/object-card.json").read_text()),
                     "InteractionSpec": json.loads((PUBLIC / "cam/schema/interaction-spec.json").read_text())}
        understood = clients.spark.understand(source_url, contracts, [])
        _refuse_safety(understood)
        if understood.get("category") not in CATEGORIES or understood.get("size") not in ("S", "M", "L"):
            raise ValueError("category or size refused")
        name = understood.get("name", "")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z]+(?:[ -][A-Za-z]+){0,3}", name):
            raise ValueError("invalid name")
        card = understood.get("object_card")
        if not isinstance(card, dict):
            raise ValueError("invalid ObjectCard")
        schema_check(card, contracts["ObjectCard"])
        _check_hazards(card)
        if "prop_poses" in card or any(card[k] != understood[k] for k in ("name", "size", "category")):
            raise ValueError("inconsistent ObjectCard")
        initial = understood.get("initial_state")
        if not isinstance(initial, str) or initial not in card.get("states", []):
            raise InteractionContractError("initial state must be a card state")
        interactions = understood.get("interactions")
        if not isinstance(interactions, list) or len(interactions) > 3:
            raise ValueError("interaction candidate count")
        for candidate in interactions:
            schema_check(candidate, contracts["InteractionSpec"])
            _check_candidate(card, candidate)
        record(True)
        begin("box", clients.box)
        try:
            box = clients.box.box(source_url, name)
            if box is not None:
                with Image.open(io.BytesIO(raw)) as image:
                    if len(box) != 4 or any(type(v) is not int for v in box) or not (0 <= box[0] < box[2] <= image.width and 0 <= box[1] < box[3] <= image.height):
                        raise ValueError("invalid box")
                    output = io.BytesIO()
                    image.crop(box).save(output, format="PNG")
                    source_url = data_url(output.getvalue())
            record(True, "no crop" if box is None else "box crop")
        except Exception:
            # Optional segmentation is never allowed to block the gift.
            record(False, "no crop; box unavailable")
        begin("redraw", clients.image)
        reference = (art_profile.reference if art_profile else PUBLIC / "room/bg-day.jpg").read_bytes()
        reference_mime = "image/png" if art_profile else "image/jpeg"
        redrawn = clients.image.redraw(source_url, name, card["size"], data_url(reference, reference_mime))
        source_format = getattr(clients.image, "last_source_format", None)
        if source_format in ("webp", "jpeg"):
            record(True, "source " + source_format + " converted to png")
        else:
            record(True)
        begin("pixelize")
        sprite = art_profile.process(redrawn, card["size"]) if art_profile else pixelize(redrawn, card["size"], room_palette(reference))
        record(True, "room-conditioned high-resolution RGBA; no pixel quantization" if art_profile else "")
        begin("upload")
        path = "/media/gift-" + gift_id + ".png"
        response = http_fn("PUT", worker_base + path, {**headers, "Content-Type": "image/png"}, sprite)
        if not 200 <= response.status < 300:
            raise ValueError("upload failed")
        record(True)
        begin("ingest")
        return send({"type": "gift_ready", "gift_id": gift_id, "name": name,
                     "size": card["size"], "sprite": path, "object_card": card,
                     "initial_state": initial,
                     "interactions": interactions, "pipeline": steps,
                     "contract_version": CONTRACT_VERSION,
                     "content_safety": understood.get("content_safety"),
                     "identifiable_person_present": False,
                     "cost_usd": sum(s["cost_usd"] for s in steps)})
    except Exception as exc:
        # Never copy exception messages, photo text, URLs or secrets into logs/ingest.
        # Only the exception class and an integer HTTP status are recorded.
        note = "step failed: " + safe_error(exc)
        detail = _client_message(exc)
        if detail:
            note += ": " + detail
        record(False, note)
        return send({"type": "gift_failed", "gift_id": gift_id, "step": step,
                     "pipeline": steps, "cost_usd": sum(s["cost_usd"] for s in steps)})
