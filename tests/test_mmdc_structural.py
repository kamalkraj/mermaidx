"""mermaidx's SVG vs mmdc's, parsed with pygixml and compared node by node (tests/svg_compare.py): the same
elements, attributes, text, comments and whitespace in the same order, nothing more or less on either side. Only
the numbers get a tolerance (float round-off, up to one LayoutUnit -- 1/64 px -- of layout rounding); they do not
have to be the same digits. The few ids mermaid.js draws at random are masked, in the reference as much as here.
"""
import glob
import os
import sys

import pytest

import mermaidx
import svg_compare as sc

HERE = os.path.dirname(__file__)
SAMPLES = sorted(os.path.splitext(os.path.basename(p))[0] for p in glob.glob(os.path.join(HERE, "samples", "*.mmd")))

BACKENDS = ("quickjs", "v8")

# (backend, sample) -> why it differs from mmdc. strict xfail: the day one of these starts to match, the test fails
# and the entry has to go.
_C4_REASON = (
    "mermaid 12's C4 text blocks come out 0.06 px wider than in Chrome (`translate(-72.1789, ..)` against "
    "`translate(-72.1172, ..)`), \"Internet Banking System\" wraps after \"Internet Banking\" here and not in the reference, "
    "and the layout then differs. What was measured outside mermaid, with Chrome 153's getComputedTextLength() on the "
    "same font: at 11, 12, 14 and 13.44 px the shim's text width is within 0.02 px, at the fractional 11.48 px of the "
    "description text Chrome is about 0.09 % narrower than a linear scaling of the font size. That measurement used "
    "the default arguments of @sparticuz/chromium, not the flags of the reference recipe, so this is where to look, "
    "not an established cause."
)

KNOWN_DIFFERENT = {
    ("quickjs", "24_c4_context"): _C4_REASON,
    ("v8", "24_c4_context"): _C4_REASON,
    ("v8", "39_mindmap_shapes"): (
        "cose-bilkent runs one cooling cycle more than with quickjs. Math.sin of mini-racer's V8 differs by 1 ulp "
        "from quickjs/libm (sin(-5.969026041820607), sin(0.5569781975426904)); replaying quickjs's Math.sin results "
        "in V8 gives 0 differences. Why mini-racer's sin differs (V8 version / build flags) is not known."
    ),
}


# Same sample, other cause: quickjs calls the libm of the platform. On macOS (CI, macos-latest) the output of
# quickjs is the same as that of V8 on Linux (viewBox, edge `d` and `data-points` compared one by one), not the
# one of mmdc. Only measured for this sample and only on macOS; Windows is not known.
KNOWN_DIFFERENT_ON = {
    ("darwin", "quickjs", "39_mindmap_shapes"): (
        "libm of macOS gives other Math results than the reference, so cose-bilkent ends in another cooling cycle"
    ),
}


def _known_different(backend, name):
    return KNOWN_DIFFERENT.get((backend, name)) or KNOWN_DIFFERENT_ON.get((sys.platform, backend, name))


def _cases():
    for backend in BACKENDS:
        for name in SAMPLES:
            marks = []
            reason = _known_different(backend, name)
            if reason:
                marks.append(pytest.mark.xfail(strict=True, reason=reason))
            yield pytest.param(backend, name, marks=marks, id=f"{backend}-{name}")


@pytest.mark.parametrize("backend, name", list(_cases()))
def test_svg_is_the_same_document_as_mmdc(backend, name):
    if backend == "v8":
        pytest.importorskip("py_mini_racer")
    src = open(os.path.join(HERE, "samples", name + ".mmd"), encoding="utf-8").read()
    ref = open(os.path.join(HERE, "samples", name + ".svg"), encoding="utf-8").read()
    ours = mermaidx.render(src, config={"handDrawnSeed": 1}, backend=backend).svg()
    diffs = sc.compare(sc.parse(sc.mask_random_ids(ours)), sc.parse(sc.mask_random_ids(ref)))
    assert not diffs, f"{len(diffs)} differences, first:\n" + "\n".join(diffs[:5])


@pytest.mark.parametrize("name", ["06_complex_sequence", "38_class_advanced", "01_simple_flowchart"])
def test_rendering_twice_gives_the_same_bytes(name):
    """mmdc opens a fresh page per diagram, so mermaid.js's id counters (actor1, classId-Animal-0, ...) always
    start from zero. Each mermaidx render must start from the same state, whatever was rendered before."""
    src = open(os.path.join(HERE, "samples", name + ".mmd"), encoding="utf-8").read()
    first = mermaidx.render(src, config={"handDrawnSeed": 1}).svg()
    second = mermaidx.render(src, config={"handDrawnSeed": 1}).svg()
    assert first == second
