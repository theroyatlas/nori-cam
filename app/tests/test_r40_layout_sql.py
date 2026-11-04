"""site/oneoff/r40_layout.sql stays in step with layout_cells and keeps its no-op guards."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load():
    spec = importlib.util.spec_from_file_location('r40_layout_sql', ROOT / 'tools' / 'r40_layout_sql.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_committed_sql_matches_generator():
    mod = load()
    assert (ROOT / 'site' / 'oneoff' / 'r40_layout.sql').read_text(encoding='utf-8') == mod.build_sql()


def test_every_write_is_guarded():
    sql = load().build_sql()
    writes = [l for l in sql.splitlines() if l.split(' ', 1)[0] in ('INSERT', 'DELETE', 'UPDATE')]
    assert writes[0].startswith("UPDATE world SET writer='r40-layout-applying'") and 'NOT EXISTS (SELECT 1 FROM gifts)' in writes[0]
    for line in writes[1:]:
        assert "writer='r40-layout-applying'" in line, line
