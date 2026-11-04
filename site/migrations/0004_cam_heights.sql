-- A2c: insert missing high places and interactions; safe to apply repeatedly.
INSERT OR IGNORE INTO object_cards (id,object_id,created_at,source,card)
VALUES ('card:o_cat_tree',
  'o_cat_tree',
  CAST(strftime('%s','now') AS INTEGER)*1000,
  'prefab',
  '{"name":"cat tree","category":"furniture","size":"M","height":"mid","tags":["high_place","'
    || 'soft","viewpoint"],"sensations":{"height":0.5,"view_far":0.5,"soft":0.3},"parts":[{"kind":'
    || '"front","label":"mid platform","side":"front","height":"low"},{"kind":"top","label":"top p'
    || 'latform","side":"top","height":"mid"}],"states":["default"],"space":{"cm":{"w":40,"d":40,"'
    || 'h":120},"blocks":true,"placement":"floor","movable":{"push":false,"rotate":false,"stack":f'
    || 'alse},"state_cm":{}},"affordances":[],"beyond_executor":[],"summary":"Prefab cat_tree","pr'
    || 'op_poses":[]}');
INSERT OR IGNORE INTO objects (id,kind,tags,size,x,y,z,footprint,rotation,blocks,placement,status,state,sprite,
  card_id,origin,created_at)
VALUES ('o_cat_tree',
  'cat_tree',
  '["high_place","soft","viewpoint"]',
  'M',
  5,
  0,
  0,
  '[[0,0]]',
  0,
  1,
  'floor',
  'placed',
  'default',
  'procedural:cat_tree',
  'card:o_cat_tree',
  '{"type":"prefab"}',
  CAST(strftime('%s','now') AS INTEGER)*1000);
INSERT INTO object_states
  (object_id,valid_from,x,y,z,footprint,rotation,status,state,sprite,cause)
SELECT 'o_cat_tree',
  CAST(strftime('%s','now') AS INTEGER)*1000,
  5,
  0,
  0,
  '[[0,0]]',
  0,
  'placed',
  'default',
  'procedural:cat_tree',
  'seed'
WHERE NOT EXISTS (SELECT 1 FROM object_states WHERE object_id='o_cat_tree');
INSERT OR IGNORE INTO interactions (id,object_id,card_id,created_at,source,spec,status,checks)
VALUES ('ix_cat_tree_sit_on',
  'o_cat_tree',
  'card:o_cat_tree',
  CAST(strftime('%s','now') AS INTEGER)*1000,
  'prefab',
  '{"verb":"sit_on","sensations":{"height":0.5,"view_far":0.5,"soft":0.3},"steps":[{"p":"move'
    || '_to","part":"top"},{"p":"climb","part":"top"},{"p":"hold_pose","pose":"sit","ms":600000}],'
    || '"end_state":null,"cooldown_min":25,"action":"sit_on"}',
  'accepted',
  '[]');
INSERT OR IGNORE INTO interactions (id,object_id,card_id,created_at,source,spec,status,checks)
VALUES ('ix_cat_tree_sleep_at',
  'o_cat_tree',
  'card:o_cat_tree',
  CAST(strftime('%s','now') AS INTEGER)*1000,
  'prefab',
  '{"verb":"sleep_at","sensations":{"height":0.5,"view_far":0.5,"soft":0.3},"steps":[{"p":"mo'
    || 've_to","part":"top"},{"p":"climb","part":"top"},{"p":"sleep","pose":"sleepy","ms":2400000}'
    || '],"end_state":null,"cooldown_min":25,"action":"sleep"}',
  'accepted',
  '[]');
INSERT OR IGNORE INTO interactions (id,object_id,card_id,created_at,source,spec,status,checks)
VALUES ('ix_cat_tree_lie_on',
  'o_cat_tree',
  'card:o_cat_tree',
  CAST(strftime('%s','now') AS INTEGER)*1000,
  'prefab',
  '{"verb":"lie_on","sensations":{"height":0.5,"view_far":0.5,"soft":0.3},"steps":[{"p":"move'
    || '_to","part":"top"},{"p":"climb","part":"top"},{"p":"hold_pose","pose":"alert-loaf","ms":60'
    || '0000}],"end_state":null,"cooldown_min":25,"action":"lie_on"}',
  'accepted',
  '[]');
INSERT OR IGNORE INTO object_cards (id,object_id,created_at,source,card)
VALUES ('card:o_wall_shelf',
  'o_wall_shelf',
  CAST(strftime('%s','now') AS INTEGER)*1000,
  'prefab',
  '{"name":"wall shelf","category":"furniture","size":"M","height":"mid","tags":["high_place"'
    || ',"soft","viewpoint"],"sensations":{"height":0.5,"view_far":0.5,"soft":0.3},"parts":[{"kind'
    || '":"front","label":"mid platform","side":"front","height":"low"},{"kind":"top","label":"top'
    || ' platform","side":"top","height":"mid"}],"states":["default"],"space":{"cm":{"w":40,"d":40'
    || ',"h":120},"blocks":false,"placement":"wall","movable":{"push":false,"rotate":false,"stack"'
    || ':false},"state_cm":{}},"affordances":[],"beyond_executor":[],"summary":"Prefab wall_shelf"'
    || ',"prop_poses":[]}');
INSERT OR IGNORE INTO objects (id,kind,tags,size,x,y,z,footprint,rotation,blocks,placement,status,state,sprite,
  card_id,origin,created_at)
VALUES ('o_wall_shelf',
  'wall_shelf',
  '["high_place","soft","viewpoint"]',
  'M',
  5,
  0,
  3,
  '[[0,0]]',
  0,
  0,
  'wall',
  'placed',
  'default',
  'procedural:wall_shelf',
  'card:o_wall_shelf',
  '{"type":"prefab"}',
  CAST(strftime('%s','now') AS INTEGER)*1000);
INSERT INTO object_states
  (object_id,valid_from,x,y,z,footprint,rotation,status,state,sprite,cause)
SELECT 'o_wall_shelf',
  CAST(strftime('%s','now') AS INTEGER)*1000,
  5,
  0,
  3,
  '[[0,0]]',
  0,
  'placed',
  'default',
  'procedural:wall_shelf',
  'seed'
WHERE NOT EXISTS (SELECT 1 FROM object_states WHERE object_id='o_wall_shelf');
INSERT OR IGNORE INTO interactions (id,object_id,card_id,created_at,source,spec,status,checks)
VALUES ('ix_wall_shelf_sit_on',
  'o_wall_shelf',
  'card:o_wall_shelf',
  CAST(strftime('%s','now') AS INTEGER)*1000,
  'prefab',
  '{"verb":"sit_on","sensations":{"height":0.5,"view_far":0.5,"soft":0.3},"steps":[{"p":"move'
    || '_to","part":"top"},{"p":"climb","part":"top"},{"p":"hold_pose","pose":"sit","ms":600000}],'
    || '"end_state":null,"cooldown_min":25,"action":"sit_on"}',
  'accepted',
  '[]');
INSERT OR IGNORE INTO interactions (id,object_id,card_id,created_at,source,spec,status,checks)
VALUES ('ix_wall_shelf_look_out',
  'o_wall_shelf',
  'card:o_wall_shelf',
  CAST(strftime('%s','now') AS INTEGER)*1000,
  'prefab',
  '{"verb":"look_out","sensations":{"height":0.5,"view_far":0.5,"soft":0.3},"steps":[{"p":"mo'
    || 've_to","part":"top"},{"p":"climb","part":"top"},{"p":"hold_pose","pose":"back","ms":600000'
    || '}],"end_state":null,"cooldown_min":25,"action":"look_out"}',
  'accepted',
  '[]');
INSERT OR IGNORE INTO interactions (id,object_id,card_id,created_at,source,spec,status,checks)
VALUES ('ix_slipper_physics',
  'o_slipper',
  'card:o_slipper',
  CAST(strftime('%s','now') AS INTEGER)*1000,
  'prefab',
  '{"verb":"play","sensations":{"soft":0.3},"steps":[{"p":"move_to","part":"front"},{"p":"tou'
    || 'ch","part":"front","ms":1000}],"end_state":null,"cooldown_min":25,"action":"play"}',
  'accepted',
  '[]');
