CREATE TABLE IF NOT EXISTS world (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,          -- 每次成功寫入規劃就 +1
  writer TEXT NOT NULL,              -- 本次寫入的隨機 token（樂觀鎖用，見 §3.4）
  engine_version TEXT NOT NULL,      -- 例如 "cam-1"；改引擎規則就要升版
  timeline_until INTEGER NOT NULL,   -- 時間軸已排到哪裡
  state_json TEXT NOT NULL,          -- 見下方 WorldState
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY,               -- "o_" + 8 碼
  kind TEXT NOT NULL,                -- 型錄鍵，例如 cardboard_box、slipper、parcel、drawing、sofa
  tags TEXT NOT NULL,                -- JSON 陣列，值只能來自 §4.1 的標籤
  size TEXT NOT NULL,                -- S | M | L
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL DEFAULT 0,  -- 格子座標，見 §3.1；x、y 是佔地的基準格
  footprint TEXT NOT NULL,           -- JSON：佔用的格子，相對基準格，例如 [[0,0],[1,0]]（§3.10）
  rotation INTEGER NOT NULL DEFAULT 0, -- 0 或 90；旋轉後的佔地由共用模組算
  blocks INTEGER NOT NULL DEFAULT 1, -- 1 擋路；0 不擋（地毯、陽光區、畫）
  placement TEXT NOT NULL DEFAULT 'floor', -- floor | surface:<object id> | wall
  status TEXT NOT NULL,              -- placed | carried | stored | removed
  state TEXT NOT NULL DEFAULT 'default', -- 物件狀態，值必須在它的 ObjectCard.states 裡（§13.1），例如 closed | open
  sprite TEXT NOT NULL,              -- 圖片路徑，例如 /cam/obj/cardboard_box.png 或 /media/gift-<id>.png
  card_id TEXT,                      -- object_cards.id；預製物件也有（寫在型錄裡）
  origin TEXT NOT NULL,              -- JSON：{type: prefab|gift|photo_gift|drawing, gift_id?, event_id?, source_url?, label}
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
-- 物件的歷史狀態，回放用（修正 9）。物件每次被移動、改狀態、移除，都在同一個 batch 裡
-- 把舊列的 valid_to 填上，再插入新列。目前狀態 = valid_to IS NULL 的那一列。
CREATE TABLE IF NOT EXISTS object_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id TEXT NOT NULL,
  valid_from INTEGER NOT NULL, valid_to INTEGER,
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
  footprint TEXT NOT NULL, rotation INTEGER NOT NULL,
  status TEXT NOT NULL, state TEXT NOT NULL, sprite TEXT NOT NULL,
  cause TEXT NOT NULL                -- 造成變化的 event id 或 segment id
);
CREATE INDEX IF NOT EXISTS os_time ON object_states(valid_from);
CREATE INDEX IF NOT EXISTS os_open ON object_states(object_id) WHERE valid_to IS NULL;
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,               -- 冪等鍵，見 §3.5；重送時 INSERT OR IGNORE
  insert_token TEXT NOT NULL,        -- 這次請求的隨機值；版本只在這列真的由本次請求插入時才 +1（§3.5）
  at INTEGER NOT NULL,
  type TEXT NOT NULL,                -- 見 §4.4
  actor TEXT NOT NULL,               -- nori | visitor | owner | judge | system | brain
  payload TEXT NOT NULL,             -- JSON
  public INTEGER NOT NULL DEFAULT 1,
  world_version INTEGER NOT NULL,
  handled_version INTEGER            -- 規劃者處理這個事件時，在同一個受保護的 batch 裡填入（§3.4）；NULL 表示還沒處理
);
CREATE INDEX IF NOT EXISTS ev_unhandled ON events(at) WHERE handled_version IS NULL;
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  action TEXT NOT NULL,              -- 見 §4.2
  primitive TEXT,                    -- 這段執行的基本動作（§13.3）；規則行為也填
  pose TEXT NOT NULL,                -- 見 §4.3
  facing INTEGER NOT NULL DEFAULT 1, -- 1 朝右，-1 朝左（renderer 水平翻轉）
  path TEXT NOT NULL,                -- JSON [[x,y],...]，至少一點；不移動時就是一點
  z REAL NOT NULL DEFAULT 0,
  target TEXT,                       -- object id
  part TEXT,                         -- 目標部位（§13.1 的部位列舉）
  carrying TEXT,                     -- object id
  interaction TEXT,                  -- interactions.id；屬於某個互動規格時填入
  effects TEXT,                      -- JSON 陣列：片段正常結束時才生效的世界變化（§13.4）；renderer 也用它預先畫出結果
  completion TEXT,                   -- Server-only; strip from /api/cam.
  trigger TEXT,                      -- JSON：片段真正開始時才派出的非同步工作，例如 {"kind":"browse"}（§3.9）
  trigger_claimed_at INTEGER, trigger_status TEXT,  -- 認領時間；dispatched | budget_denied | failed
  source TEXT NOT NULL,              -- routine | intent:<id> | reaction:<event_id> | interaction:<id> | safe | catchup
  debug TEXT,                        -- JSON：前 3 名候選和分數（只給除錯版）
  world_version INTEGER NOT NULL,
  cut_at INTEGER,                    -- 被截短時填入截點；有值就表示「沒有做完」，effects 不生效（§3.8）
  settled_at INTEGER,                -- 結算完成時間；NULL 表示還沒結算
  superseded_at INTEGER              -- 被重排取代時填入；查詢時只取 NULL
);
CREATE INDEX IF NOT EXISTS seg_live ON segments(start_at) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS seg_unsettled ON segments(end_at) WHERE settled_at IS NULL AND superseded_at IS NULL;
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
  source TEXT NOT NULL,              -- spark_reaction | spark_plan | wonder
  model TEXT NOT NULL, trigger_event TEXT,
  raw TEXT NOT NULL,                 -- 模型原始 JSON（存起來，除錯版顯示）
  accepted TEXT, rejected TEXT,      -- 驗證結果與原因
  status TEXT NOT NULL,              -- active | done | expired | rejected
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gifts (
  id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL,
  insert_token TEXT NOT NULL,        -- 同 events.insert_token
  giver TEXT NOT NULL,               -- visitor:<當日鹽雜湊> | owner | judge
  kind TEXT NOT NULL,                -- catalog:<key> | photo
  status TEXT NOT NULL,              -- placed | processing | ready | failed
  object_id TEXT, pipeline TEXT,     -- pipeline：每一步的 {step, model, ok, ms, cost_usd, note}
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL,
  purpose TEXT NOT NULL,             -- spark_reaction | spark_plan | wonder | browse | gift_vision | gift_sam | gift_image | gift_state_image
  model TEXT NOT NULL, ref TEXT, ok INTEGER NOT NULL,
  cost_usd REAL NOT NULL, latency_ms INTEGER, summary TEXT
);
-- 預算帳本（修正 4）：派工或呼叫模型前先預留，結果回來再結算。見 §8.1。
CREATE TABLE IF NOT EXISTS budget_ledger (
  id TEXT PRIMARY KEY,               -- res:<purpose>:<ref>，ref 是 segment id、gift id 或 event id；重送不會重複預留
  day TEXT NOT NULL,                 -- 倫敦日期 YYYY-MM-DD
  purpose TEXT NOT NULL,
  status TEXT NOT NULL,              -- reserved | settled | released
  est_usd REAL NOT NULL, actual_usd REAL,
  created_at INTEGER NOT NULL, settled_at INTEGER, note TEXT
);
CREATE INDEX IF NOT EXISTS bl_day ON budget_ledger(day, purpose);
-- 開放式互動（§13）。
CREATE TABLE IF NOT EXISTS object_cards (          -- 模型「看懂了什麼」，原文保存
  id TEXT PRIMARY KEY, object_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  source TEXT NOT NULL,              -- prefab | spark_vision
  model TEXT, raw TEXT,              -- 模型原始輸出；預製物件為 NULL
  card TEXT NOT NULL,                -- 驗證後的 ObjectCard JSON（§13.1）
  errors TEXT                        -- 被丟掉的欄位與原因
);
CREATE TABLE IF NOT EXISTS interactions (          -- 編譯後的互動規格與檢查結果
  id TEXT PRIMARY KEY, object_id TEXT NOT NULL, card_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  source TEXT NOT NULL,              -- prefab | compiled | fallback
  spec TEXT NOT NULL,                -- InteractionSpec JSON（§13.2）
  status TEXT NOT NULL,              -- accepted | degraded | rejected
  checks TEXT NOT NULL,              -- 每一項檢查的結果（§13.5）
  gaps TEXT                          -- 能力缺口：模型想做、引擎做不到的事
);
CREATE TABLE IF NOT EXISTS experiences (           -- 做完一次互動後的經驗（§13.6）
  id TEXT PRIMARY KEY,               -- exp:<interaction_id>:<最後一個 segment id>
  at INTEGER NOT NULL, object_id TEXT NOT NULL, interaction_id TEXT NOT NULL,
  segment_ids TEXT NOT NULL,         -- JSON
  sensations TEXT NOT NULL,          -- 這次實際感受到的感覺與強度
  startle REAL NOT NULL,             -- 0..1，接觸當下的驚嚇（§13.6）
  appraisal REAL NOT NULL,           -- -1..1，做完後的評價，由 §13.6 的固定公式算出，不是模型給的
  reaction TEXT NOT NULL,            -- 反應姿勢（當下與事後）
  pref_deltas TEXT NOT NULL, wariness_deltas TEXT NOT NULL, familiarity_delta REAL NOT NULL,
  world_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wishes (                -- P1，§15
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  label TEXT NOT NULL, sensations TEXT NOT NULL,
  source_url TEXT NOT NULL, source_title TEXT NOT NULL, quote TEXT NOT NULL,
  browse_event TEXT NOT NULL,        -- 來自哪一次 browse_result
  status TEXT NOT NULL,              -- active | fulfilled | expired
  fulfilled_by TEXT                  -- gift id
);

CREATE TABLE IF NOT EXISTS weather (hour_utc INTEGER PRIMARY KEY, condition TEXT NOT NULL, temp_c REAL, cloud_pct INTEGER, precip_mm REAL, wind_kph REAL, is_day INTEGER, fetched_at INTEGER NOT NULL, source TEXT NOT NULL);
