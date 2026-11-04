"""Owner-only prompt contract; original model adapters/validators stay unchanged."""
from .clients import MetaSpark

STATE_CONTRACT = {
    "order": "Declare object_card.states first; use those exact strings for every state reference.",
    "initial_state": "Must be exactly one declared object_card.states value visible in the photo.",
    "allowed_states": "May be omitted or [] for all declared states. Otherwise a nonempty subset of object_card.states; exact strings only.",
    "end_state": "Use JSON null when the interaction leaves state unchanged. Never use invented sentinel strings such as unchanged, none, or null-as-text.",
    "transition": "A non-null end_state must belong to object_card.states AND to allowed_states whenever allowed_states is nonempty. Do not describe a transition to a state excluded by its own allowed_states.",
    "references": "Every state-bearing step/effect and hazard state reference must use declared card state strings; keep all hazard/interaction safety requirements and only executor-supported primitives.",
    "self_check": "Before returning JSON, check initial_state membership and EACH interaction's allowed_states/end_state relationship. Repair your proposed JSON before responding, not the executor rules. No canned card, forced gift reaction or unsupported primitive.",
}


class OwnerSpark(MetaSpark):
    def understand(self, image_data_url, executor, wishes):
        return super().understand(image_data_url, {**executor, "OWNER_STATE_CONSISTENCY": STATE_CONTRACT}, wishes)
