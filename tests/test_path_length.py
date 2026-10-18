"""`getTotalLength()` of an SVG <path>, checked against what Chrome 153 returned for every distinct `d` in
tests/samples (tests/data/chrome_path_length.json).

mermaid 12 uses it for the `stroke-dasharray` of every edge in the neo look. Chrome's value is the true arc length
to within float32 noise, so straight segments are exact (to the float32 bit) and curves agree to ~1e-5 relative;
the comparison uses the same tolerance as tests/svg_compare.py (rel 1e-4, abs 0.02)."""
import json
import math
import pathlib
import struct

import pytest
import quickjs

from mermaidx.path_bbox import PATH_BBOX_JS

_DATA = json.loads((pathlib.Path(__file__).parent / "data" / "chrome_path_length.json").read_text())["paths"]
_CURVES = set("QqCcSsTtAa")


def _f32(v: float) -> float:
    return struct.unpack("f", struct.pack("f", v))[0]


@pytest.fixture(scope="module")
def ctx():
    c = quickjs.Context()
    c.eval(PATH_BBOX_JS)
    return c


@pytest.fixture(scope="module")
def ours(ctx):
    ds = json.dumps([p["d"] for p in _DATA])
    return json.loads(ctx.eval(f"JSON.stringify({ds}.map(d => __pathLength(d)))"))


def test_every_path_matches_chrome_within_tolerance(ours):
    bad = [(p["d"][:60], p["length"], o) for p, o in zip(_DATA, ours)
           if not math.isclose(o, p["length"], rel_tol=1e-4, abs_tol=0.02)]
    assert not bad, f"{len(bad)} of {len(_DATA)} paths differ from Chrome, first: {bad[:3]}"


def test_straight_paths_match_chrome_to_the_bit(ours):
    straight = [(p, o) for p, o in zip(_DATA, ours) if not (_CURVES & set(p["d"]))]
    assert len(straight) > 100  # the neo edges of the samples
    off = [(p["d"], p["length"], o) for p, o in straight if _f32(o) != _f32(p["length"])]
    assert not off, f"{len(off)} straight paths are not bit-identical, first: {off[:3]}"


@pytest.mark.parametrize("d, expected", [
    ("", 0),
    ("M0,0L3,4", 5),
    ("M0,0L10,0L10,10Z", 10 + 10 + math.hypot(10, 10)),   # the closing segment counts
    ("M0,0L10,0L10,10z", 10 + 10 + math.hypot(10, 10)),
    ("M0,0H10V10", 20),
    ("M0,0L10,0M5,5L5,15", 20),                              # sub-paths add up
    ("M0,0L10,0L10,10zm5,5l3,4", 10 + 10 + math.hypot(10, 10) + 5),  # relative moves restart at the sub-path start
])
def test_known_lengths(ctx, d, expected):
    assert ctx.eval(f"__pathLength({d!r})") == pytest.approx(expected, rel=1e-6)

