# Autotagging

PhotoMapAI can suggest a short, human-readable label for every cluster in the [Semantic Map](semantic-map.md) and for individual images in the metadata drawer. The labels are *suggestions* — they are inferred from the image content, not pulled from EXIF, filenames, or any metadata you've written yourself. Nothing is sent to an external service; the matching runs locally using the same CLIP/SigLIP encoder that powers semantic search.

This page covers how to turn the feature on, what kinds of labels it produces, how to extend the vocabulary with your own phrases, and — for developers — how the bundled vocabulary file is generated.

---

## Activating Autotagging

Autotagging is **off by default**. The first time it runs against an album, it has to encode the entire labeling vocabulary (~1,700 phrases) through the active CLIP/SigLIP model. On machines without a GPU this can take several minutes, which is why the feature is opt-in.

To turn it on:

1. Click the gear icon to open the **Settings** dialog.
2. Expand the **Autotagging** section.
3. Tick **Activate autotagging**.

Changes take effect the next time the Semantic Map is loaded — typically the next album switch or page reload. With a GPU available, the first build takes a few seconds. Without one, expect the first map open to pause for one to several minutes while the vocabulary is encoded. The result is cached on disk per encoder, so subsequent map opens for the same album (or any album using the same encoder) are instant.

To turn it off, untick the box. Any labels currently shown in the UI are cleared immediately; the cached vocabulary embeddings stay on disk so that re-enabling later does not require another build.

!!! note "Where the cache lives"
    The vocabulary embeddings cache is stored under your platform's user cache directory:
    `~/.cache/photomap/cluster_vocab/` on Linux,
    `~/Library/Caches/photomap/cluster_vocab/` on macOS,
    and `%LOCALAPPDATA%\photomap\Cache\cluster_vocab\` on Windows.
    You can safely delete it to force a rebuild on next use.

---

## Cluster Tags vs Image Tags

Autotagging produces two related but distinct kinds of label.

### Cluster tags

A **cluster tag** describes a whole DBSCAN cluster on the Semantic Map — that is, a group of images PhotoMapAI has decided are semantically similar. The tag is chosen by averaging the embeddings of every image in the cluster and finding the vocabulary phrase whose embedding sits closest to that average. The result is one short phrase that summarizes the cluster's centroid.

Cluster tags appear in the hover popup over any colored cluster on the Semantic Map (e.g. `Cluster 3 (size=412) — "mountain landscape"`).

Because the tag describes the cluster's *aggregate* content, it can drift from any one image inside the cluster — especially when the cluster is heterogeneous. A cluster whose centroid is best described as "outdoor portrait" may still contain individual photos that are pure landscape or pure close-up.

### Image tags

An **image tag** is computed against a single image's embedding rather than a cluster centroid. It answers "what does *this picture* look like?" independent of how the picture happens to cluster with its neighbors.

Image tags appear in two places in the UI:

- The **score-display pill** that overlays the active image in the slideshow.
- The **metadata drawer**, alongside the EXIF and generator-metadata fields.

When a cluster is uniform, the image tag and the cluster tag usually match. When the cluster is mixed, they may diverge — and that divergence is itself useful information about how confident the clustering is for that particular image.

---

## Adding Custom Labels

The bundled vocabulary covers indoor and outdoor scenes (Places365), common objects with bounding boxes (OpenImages V7 boxable), and the thousand most frequently human-verified labels from the OpenImages V7 validation set. That is a broad starting point, but it cannot anticipate every collection — you may want to add names of family members, breeds of your specific dog, the model of your car, regional landmarks, or anything else that recurs in your photos.

You can extend the vocabulary with a personal file called `cluster_vocab_extra.txt`, placed in your PhotoMapAI config directory (the same directory that holds `config.yaml`):

| OS      | Location |
|---------|----------|
| Linux   | `~/.config/photomap/cluster_vocab_extra.txt` |
| macOS   | `~/Library/Application Support/photomap/cluster_vocab_extra.txt` |
| Windows | `%APPDATA%\photomap\cluster_vocab_extra.txt` |

The format is one phrase per line. Blank lines and lines starting with `#` are ignored, so you can group phrases under comments for your own bookkeeping. Phrases are lowercased automatically; spaces are fine, underscores are converted to spaces.

```text
# people
mary at the playground
timmy in his red jacket

# places
the cabin
brookline farmers market

# our pets
rocky the labrador
luna the tabby
```

After editing this file, delete the cached embeddings (see the note above) so the next map open picks up your additions, or simply switch encoders and switch back to force a rebuild. Your custom phrases are unioned with the bundled vocabulary and competed against on equal footing — there is no special weighting.

!!! tip "Specificity beats abstraction"
    The matcher works by embedding similarity, so concrete, visually distinctive phrases (`"rocky the labrador on the beach"`) score more reliably than abstract ones (`"happiness"`). If a phrase never seems to win, try a more visually specific variant.

If you have a checkout of the PhotoMapAI source and want your additions to ship to other instances, you can instead add them below the `# CURATED` sentinel line in `photomap/backend/data/cluster_vocab.txt`. Phrases below that line are preserved across re-runs of the `build_vocab.py` script (see below).

---

## The `build_vocab.py` Script (for developers)

The bundled vocabulary file at `photomap/backend/data/cluster_vocab.txt` is generated by `scripts/build_vocab.py`. Most users never need to run this — the bundled file is part of the release. The script exists so the vocabulary can be regenerated when the upstream datasets change or when we want to tune how the vocab is composed.

Run it from a checkout:

```bash
python scripts/build_vocab.py
```

It fetches three datasets:

1. **Places365** scene categories (CSAILVision, CC).
2. **OpenImages V7 boxable** class descriptions (Google, CC-BY 4.0). These cover concrete object classes that humans have drawn bounding boxes around.
3. **OpenImages V7 validation human-verified labels** + the full **OpenImages V7 class descriptions** CSV. The script counts how often each class is verified *present* (`Confidence=1.0`) in the validation set, takes the top-N most-frequent classes, and joins against the class descriptions to recover human-readable phrases.

Ranking the OpenImages V7 augmentation by real-photo verification frequency biases the vocabulary toward labels that actually show up in photographs, rather than the long tail of obscure trainable classes. The top-N cutoff is controlled by the `TOP_VAL_LABELS` constant near the top of the script (currently 1000). Larger values broaden coverage at the cost of a slower first-time index build.

All three sources are normalized — lowercased, underscores to spaces, length-bounded — and then merged with cross-source deduplication. Places365 wins over boxable on overlap; boxable wins over the validation-frequency set; anything below the `# CURATED` sentinel in the existing file is preserved verbatim across re-runs.

The output is written back to `photomap/backend/data/cluster_vocab.txt`. Commit both the script and the regenerated vocab file together — they are designed to be reproducible from the script alone, but downstream installs that consume the package only get the committed file.
