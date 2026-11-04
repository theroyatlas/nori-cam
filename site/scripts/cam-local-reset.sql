-- Reset local cam D1 to seeded baseline without deleting wrangler state files.
-- Generated for cam-local-e2e; safe to re-run (INSERT OR IGNORE on world seed).
DELETE FROM model_calls;
DELETE FROM budget_ledger;
DELETE FROM intents;
DELETE FROM experiences;
DELETE FROM interactions WHERE source='compiled';
DELETE FROM events;
DELETE FROM gifts;
DELETE FROM segments;
DELETE FROM object_states WHERE cause NOT IN ('seed');
DELETE FROM objects WHERE origin NOT LIKE '%prefab%' AND origin NOT LIKE '%"type":"prefab"%';
DELETE FROM object_cards WHERE source NOT IN ('prefab', 'seed');
