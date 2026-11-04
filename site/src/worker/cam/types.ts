export type Cell = [
    number,
    number
];
export type Sensation = 'soft' | 'shelter' | 'height' | 'view_far' | 'sound' | 'motion' | 'light' | 'warm';
export type Sensations = Partial<Record<Sensation, number>>;
export interface Part {
    kind: string;
    label: string;
    side: string;
    height: string;
}
export interface Dimensions {
    w: number;
    d: number;
    h: number;
}
export interface ObjectCard {
    name: string;
    category: string;
    size: 'S' | 'M' | 'L';
    height: string;
    tags: string[];
    sensations: Sensations;
    parts: Part[];
    states: string[];
    hazards?: {
        kind: string;
        parts: string[];
        states: string[];
    }[];
    space: {
        cm: Dimensions;
        blocks: boolean;
        placement: string;
        movable: {
            push: boolean;
            rotate: boolean;
            stack: boolean;
        };
        state_cm: Record<string, Dimensions>;
    };
    affordances: {
        verb: string;
        effect_text: string;
        sensations: string[];
    }[];
    beyond_executor: string[];
    summary: string;
    prop_poses?: string[];
}
export interface Level {
    id: string;
    z: number;
    part: string;
    requires?: {
        kind: string;
        level: string;
    };
}
export interface CamObject {
    parts?: Part[];
    levels?: Level[];
    wall_side?: string;
    id: string;
    kind: string;
    x: number;
    y: number;
    z: number;
    footprint: Cell[];
    rotation: number;
    blocks: boolean;
    placement: string;
    status: string;
    state: string;
    size: string;
    tags: string[];
    sprite: string;
    card_id?: string;
    origin?: {
        type: string;
        gift_id?: string;
    };
    card: ObjectCard;
    state_sprites?: Record<string, string>;
}
export interface Effect {
    keyframes?: {
        at_ms: number;
        x: number;
        y: number;
        z: number;
    }[];
    z_from?: number;
    z_to?: number;
    reason?: string;
    e: string;
    object_id?: string;
    at_ms?: number;
    dx?: number;
    dy?: number;
    state?: string;
    on?: boolean;
    pattern?: string;
    amp?: number;
    kind?: string;
    footprint?: Cell[];
    sprite?: string;
}
export interface Step {
    p: string;
    part?: string;
    approach?: string;
    pose?: string;
    gait?: string;
    ms?: number;
    dir?: Cell;
    at?: Cell;
    state?: string;
    effects?: Effect[];
}
export interface InteractionSpec {
    verb: string;
    sensations: Sensations;
    approach?: string;
    target_part?: string | null;
    contact?: string;
    allowed_states?: string[];
    steps: Step[];
    end_state: string | null;
    cooldown_min: number;
}
export interface Interaction {
    id: string;
    object_id: string;
    spec: InteractionSpec;
    action?: string;
}
export interface CatalogEntry {
    object: CamObject;
    interactions: Interaction[];
}
export interface WorldState {
    nori: {
        z?: number;
        energy: number;
        curiosity: number;
        security: number;
        asleep: boolean;
        sleep_started_at: number | null;
        variant: 'default';
    };
    prefs: Record<Sensation, number>;
    wariness: Record<Sensation, number>;
    familiarity: Record<string, number>;
    novelty: Record<string, number>;
    habits: Record<string, {
        n: number;
        good: number;
        last_at: number;
    }>;
    missing: {
        object_id: string;
        kind: string;
        x: number;
        y: number;
        familiarity: number;
        since: number;
    }[];
    settled_through: number;
    // Settlement metadata lives inside state_json: restart-safe daily cap and idempotency.
    exploration?: {
        sensation: Sensation;
        expires_at: number;
    };
    pref_day?: string;
    pref_deltas?: Sensations;
    settled_ids?: number[];
    interrupted_ids?: number[];
}
export interface Weather {
    cloud_pct?: number;
    precip_mm?: number;
    condition?: string;
}
export interface GeometryWorld {
    objects: CamObject[];
    nori?: {
        x: number;
        y: number;
    };
    anchors?: Cell[];
}
export interface Appraisal {
    startle: number;
    appraisal: number;
    reaction: string;
}
export interface Segment {
    id: number;
    start_at: number;
    end_at: number;
    action: string;
    primitive: string;
    pose: string;
    facing: number;
    path: Cell[];
    z: number;
    z_from?: number;
    z_to?: number;
    target: string | null;
    part: string | null;
    carrying: string | null;
    interaction: string | null;
    effects: Effect[];
    source: string;
    world_version: number;
    cut_at: number | null;
    settled_at: number | null;
    superseded_at: number | null;
    trigger: {
        kind: string;
        planned_end_at?: number;
    } | null;
    // Server-only: strip completion from every /api/cam response.
    completion?: {
        last: boolean;
        segment_ids: number[];
        sensations: Sensations;
        input: WorldState;
        assessment: Appraisal;
        cell: Cell;
        start_at: number;
        end_at: number;
    };
}
export interface CamEvent {
    id: string;
    at: number;
    type: string;
    actor: string;
    payload: Record<string, unknown>;
}
export interface Experience {
    id: string;
    at: number;
    object_id: string;
    interaction_id: string;
    segment_ids: number[];
    sensations: Sensations;
    startle: number;
    appraisal: number;
    reaction: string;
    pref_deltas: Sensations;
    wariness_deltas: Sensations;
    familiarity_delta: number;
    world_version: number;
}
export interface ValidationResult {
    status: 'accepted' | 'degraded' | 'rejected';
    checks: {
        check: string;
        ok: boolean;
        reason: string | null;
    }[];
    gaps: {
        primitive: string;
        reason: string;
    }[];
    spec: InteractionSpec | null;
}
