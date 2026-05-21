"""Build the cluster-labeling vocabulary from public datasets.

Downloads Places365 scene categories and OpenImages V7 boxable classes,
normalizes them, and writes to photomap/backend/data/cluster_vocab.txt.

A `# CURATED` sentinel line in the existing file separates auto-generated
phrases (above) from hand-curated ones (below). The curated section is
preserved across re-runs; only the auto-generated sections are regenerated.

Usage:
    python scripts/build_vocab.py
"""

import csv
import io
import sys
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

PLACES365_URL = (
    "https://raw.githubusercontent.com/CSAILVision/places365/master/"
    "categories_places365.txt"
)
OPENIMAGES_URL = (
    "https://storage.googleapis.com/openimages/v7/"
    "oidv7-class-descriptions-boxable.csv"
)
OPENIMAGES_ALL_URL = (
    "https://storage.googleapis.com/openimages/v7/"
    "oidv7-class-descriptions.csv"
)
OPENIMAGES_VAL_LABELS_URL = (
    "https://storage.googleapis.com/openimages/v7/"
    "oidv7-val-annotations-human-imagelabels.csv"
)

REPO_ROOT = Path(__file__).resolve().parent.parent
VOCAB_FILE = REPO_ROOT / "photomap" / "backend" / "data" / "cluster_vocab.txt"

CURATED_SENTINEL = "# CURATED"
MIN_LEN = 3
MAX_LEN = 60

# Number of OpenImages classes to add from the human-verified validation
# labels, ranked by how often each class is actually present (Confidence=1.0).
# This biases the augmentation toward labels that show up in real photographs
# rather than the long tail of obscure trainable classes.
TOP_VAL_LABELS = 1000


def fetch(url: str, timeout: int = 30) -> str | None:
    """Download a URL, returning text or None on failure (non-fatal)."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.read().decode("utf-8")
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        print(f"  ! failed to fetch {url}: {err}", file=sys.stderr)
        return None


def normalize(phrase: str) -> str | None:
    """Lowercase, underscores-to-spaces, strip; reject if out of length bounds."""
    p = phrase.strip().lower().replace("_", " ")
    p = " ".join(p.split())  # collapse internal whitespace
    if not (MIN_LEN <= len(p) <= MAX_LEN):
        return None
    return p


def parse_places365(text: str) -> list[str]:
    """Lines look like '/a/abbey 0' or '/c/childs_room 100'.

    Places365 uses ``base/modifier`` suffixes for variants of the same scene
    category (``church/indoor``, ``arena/hockey``, ``apartment building/outdoor``).
    These read awkwardly as labels — swap to ``modifier base`` so the hover
    popup shows ``indoor church`` instead of ``church/indoor``.
    """
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        path = line.split()[0]  # e.g. '/a/abbey'
        # Strip the leading '/x/' prefix
        parts = path.lstrip("/").split("/", 1)
        if len(parts) != 2:
            continue
        label = parts[1]
        phrase = normalize(label)
        if not phrase:
            continue
        if "/" in phrase:
            base, _, modifier = phrase.partition("/")
            phrase = f"{modifier} {base}".strip()
        out.append(phrase)
    return out


def parse_openimages(text: str) -> list[str]:
    """CSV with header 'LabelName,DisplayName'. Take the DisplayName column."""
    out = []
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    if not header or "DisplayName" not in header:
        print("  ! OpenImages CSV missing expected header; skipping", file=sys.stderr)
        return out
    display_idx = header.index("DisplayName")
    for row in reader:
        if len(row) <= display_idx:
            continue
        phrase = normalize(row[display_idx])
        if phrase:
            out.append(phrase)
    return out


def parse_openimages_mid_map(text: str) -> dict[str, str]:
    """CSV with header 'LabelName,DisplayName'. Return MID -> raw DisplayName."""
    out: dict[str, str] = {}
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    if not header or "LabelName" not in header or "DisplayName" not in header:
        print("  ! OpenImages class descriptions CSV missing expected header", file=sys.stderr)
        return out
    label_idx = header.index("LabelName")
    display_idx = header.index("DisplayName")
    for row in reader:
        if len(row) <= max(label_idx, display_idx):
            continue
        out[row[label_idx]] = row[display_idx]
    return out


def count_positive_val_labels(text: str) -> Counter[str]:
    """Count MID occurrences in human-verified val labels where Confidence=1.0.

    Format is 'ImageID,Source,LabelName,Confidence'. Confidence=0.0 rows are
    verified absences (the human rated the class as NOT present) — we want the
    1.0 rows so the resulting ranking reflects what real photos contain.
    """
    counts: Counter[str] = Counter()
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    if not header or "LabelName" not in header or "Confidence" not in header:
        print("  ! val labels CSV missing expected header", file=sys.stderr)
        return counts
    label_idx = header.index("LabelName")
    conf_idx = header.index("Confidence")
    for row in reader:
        if len(row) <= max(label_idx, conf_idx):
            continue
        try:
            if float(row[conf_idx]) >= 1.0:
                counts[row[label_idx]] += 1
        except ValueError:
            continue
    return counts


def top_val_labels(
    counts: Counter[str],
    mid_to_display: dict[str, str],
    top_n: int,
) -> list[str]:
    """Take the top-N most-frequent MIDs, resolve to DisplayNames, normalize."""
    out: list[str] = []
    missing = 0
    for mid, _ in counts.most_common():
        if len(out) >= top_n:
            break
        display = mid_to_display.get(mid)
        if display is None:
            missing += 1
            continue
        phrase = normalize(display)
        if phrase:
            out.append(phrase)
    if missing:
        print(f"  ! {missing} top val MIDs not found in class descriptions", file=sys.stderr)
    return out


def read_curated_section(path: Path) -> list[str]:
    """Return the lines below the CURATED sentinel from an existing vocab file."""
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    try:
        idx = next(i for i, line in enumerate(lines) if line.startswith(CURATED_SENTINEL))
    except StopIteration:
        return []
    # Everything after the sentinel line
    return lines[idx + 1 :]


def dedupe_preserve_order(phrases: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for p in phrases:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def write_vocab(
    path: Path,
    places: list[str],
    openimages: list[str],
    val_top: list[str],
    curated_lines: list[str],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    parts: list[str] = [
        "# Cluster-labeling vocabulary for PhotoMapAI.",
        "# Auto-generated by scripts/build_vocab.py — do NOT edit auto sections by hand.",
        "# Hand-curated additions go below the CURATED sentinel line and are preserved",
        "# across re-runs of the build script.",
        "",
    ]

    if places:
        parts += [
            "# === Places365 (CSAILVision/places365, CC) ===",
            *sorted(places),
            "",
        ]
    if openimages:
        parts += [
            "# === OpenImages V7 boxable (Google, CC-BY 4.0) ===",
            *sorted(openimages),
            "",
        ]
    if val_top:
        parts += [
            f"# === OpenImages V7 top-{TOP_VAL_LABELS} by validation-set "
            "human-verified frequency (Google, CC-BY 4.0) ===",
            *sorted(val_top),
            "",
        ]

    # The "End users…" guidance and the sentinel itself are part of the
    # auto-generated header — they sit ABOVE the sentinel line so that
    # read_curated_section() (which slices everything after the sentinel)
    # captures only true user-added phrases. Putting them below would cause
    # them to be re-read as curated content and re-emitted on every run,
    # growing the file by one copy of the comments per build.
    parts.append(
        "# End users who installed via pip can add extra phrases without editing"
    )
    parts.append(
        "# this file by creating cluster_vocab_extra.txt in the photomap config"
    )
    parts.append(
        "# directory (e.g. ~/.config/photomap/ on Linux, sibling of config.yaml)."
    )
    parts.append(
        f"{CURATED_SENTINEL} — hand-added phrases below this line are preserved across re-runs. "
        "One phrase per line, lowercase; empty lines and # comments are OK."
    )
    if curated_lines:
        parts += curated_lines
    else:
        parts.append("")

    path.write_text("\n".join(parts) + "\n", encoding="utf-8")


def main() -> int:
    print(f"Vocab target: {VOCAB_FILE}")
    print(f"  Places365:   {PLACES365_URL}")
    places_text = fetch(PLACES365_URL)
    places = parse_places365(places_text) if places_text else []
    print(f"    -> {len(places)} phrases")

    print(f"  OpenImages:  {OPENIMAGES_URL}")
    oi_text = fetch(OPENIMAGES_URL)
    openimages = parse_openimages(oi_text) if oi_text else []
    print(f"    -> {len(openimages)} phrases")

    print(f"  OpenImages val labels: {OPENIMAGES_VAL_LABELS_URL}")
    val_text = fetch(OPENIMAGES_VAL_LABELS_URL)
    print(f"  OpenImages all:        {OPENIMAGES_ALL_URL}")
    all_text = fetch(OPENIMAGES_ALL_URL)
    if val_text and all_text:
        counts = count_positive_val_labels(val_text)
        mid_to_display = parse_openimages_mid_map(all_text)
        val_top = top_val_labels(counts, mid_to_display, TOP_VAL_LABELS)
    else:
        val_top = []
    print(f"    -> {len(val_top)} phrases (top by val human-verified frequency)")

    # Dedupe within each source first
    places = dedupe_preserve_order(places)
    openimages = dedupe_preserve_order(openimages)
    val_top = dedupe_preserve_order(val_top)

    # Cross-source dedupe: prefer Places365, then boxable OpenImages, then
    # the val-frequency set (drop overlaps that already appear earlier).
    seen: set[str] = set(places)
    openimages = [p for p in openimages if p not in seen]
    seen.update(openimages)
    val_top = [p for p in val_top if p not in seen]

    curated_lines = read_curated_section(VOCAB_FILE)
    curated_count = sum(
        1 for line in curated_lines if line.strip() and not line.strip().startswith("#")
    )
    print(f"  Curated (preserved): {curated_count} phrases")

    if not places and not openimages and not val_top and not curated_lines:
        print("Nothing to write; all sources failed and no existing vocab.", file=sys.stderr)
        return 1

    write_vocab(VOCAB_FILE, places, openimages, val_top, curated_lines)
    total_auto = len(places) + len(openimages) + len(val_top)
    print(f"Wrote {VOCAB_FILE} ({total_auto} auto + {curated_count} curated)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
