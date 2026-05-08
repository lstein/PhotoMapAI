# Encoders

Every PhotoMapAI album is indexed by an *encoder* — a vision-language model that converts each image, and any text query you type later, into a numeric vector. Search and the semantic map are both built on those vectors. The choice of encoder controls how similar two things look to PhotoMapAI: how well it matches a query word like *"sunset"* against an actual photo of a sunset, how forgiving it is of cluttered or stylistically varied images, and how the similarity scores you see in the UI are distributed.

Three encoders are bundled with PhotoMapAI. They have different strengths, and the right pick depends on the kind of images in your album.

## The Three Encoders

### OpenCLIP ViT-L-14 / DFN-2B  *(recommended, default for new albums)*

A larger, better-trained successor to the original CLIP. Apple released the `DFN-2B` weights in 2023, retrained on a heavily filtered 2-billion image-caption dataset. It scores meaningfully higher than legacy CLIP on virtually every published benchmark and behaves robustly across messy real-world photo collections.

- **Strengths.** Best general-purpose match for typical photo libraries — family snapshots, vacations, mixed media. Cosine similarities are in a familiar range (matching pairs around 0.20–0.35), so a threshold of 0.2 catches most legitimate hits without flooding the results with false positives. Threshold semantics are predictable and don't need per-album tuning.
- **Weaknesses.** Larger model than legacy CLIP — ~600 MB to download and slower per image to index. First-time indexing of a big album takes noticeably longer than the legacy CLIP option.
- **Pick this if** you don't have a strong reason to pick something else.

### SigLIP 2 Large

Google's 2024–25 update to SigLIP, trained with a sigmoid loss instead of CLIP's batch-softmax. This means SigLIP's similarity scores are *calibrated*: PhotoMapAI passes them through SigLIP's learned sigmoid to recover something close to "this is an X% match" probabilities, which can be more interpretable than raw cosines.

- **Strengths.** Excellent at clean, single-subject images with caption-shaped queries. Particularly good for AI-generated content (InvokeAI exports, Stable Diffusion outputs, illustration-style work) where the subject is the whole image and queries describe it directly. The calibrated scores make a confident match very obviously different from a non-match — you'll see probabilities near 0.5+ for good hits and near 0.001 for misses, with little in between.
- **Weaknesses.** That sharp calibration is a double-edged sword. SigLIP's matching cosines for a typical query land in the 0.05–0.15 range, and the calibration *cliff* sits at raw cosine ≈ 0.14. Cluttered family photos and abstract bare-noun queries (`"woman"`, `"flower"`) tend to produce raw cosines just *below* that cliff, which makes their calibrated probabilities collapse toward zero. Default thresholds for SigLIP are therefore much lower (0.005) than for CLIP-style encoders, and you'll spend more time tuning per album.
- **Pick this if** your album is mostly clean, single-subject content where you want the most confident possible matches and you're willing to tune.

### OpenAI CLIP ViT-B/32  *(legacy)*

The original 2021 CLIP — the model PhotoMapAI used for everything before the encoder layer was added. It's the smallest of the three (~150 MB, fastest to index) and uses a familiar contrastive cosine similarity.

- **Strengths.** Fastest indexing, smallest disk footprint, well-understood threshold behavior.
- **Weaknesses.** Substantially weaker than the newer alternatives across published benchmarks (e.g. ~63% ImageNet zero-shot vs. 82% for OpenCLIP-DFN). Recall on photo-style content is noticeably worse, and false positives are more frequent.
- **Pick this if** you're constrained on disk or time, or you want to keep a legacy album working without re-indexing it. Albums created before the encoder layer existed default to this, and re-indexing isn't required just because a newer option is available.

## Setting the Encoder

The encoder is a per-album setting and lives in the **Album Manager**. Open it from the **Settings** gear icon → **Manage Albums**. On both the *Add Album* form and the *Edit Album* form for an existing album, you'll find an **Encoder** dropdown listing the three options above.

The choice you make on this dropdown determines what model will be used the next time the album's index is built or updated. Pick it *before* you press the **Add Album** button (or **Save Changes** for an existing album), and indexing will use your selection from the start.

If you change the encoder on an album that already has an index, PhotoMapAI will detect the mismatch the next time you press **Update Index** for that album. It will warn you in the indexing status, delete the old index, and rebuild the album from scratch under the new encoder. This is automatic — you don't have to manage stale index files yourself — but a re-index of a large album can take significant time, so don't change the encoder casually.

If you don't see an encoder option you want, you can also set it manually in `config.yaml` (see [Configuration](configuration.md)) as the album's `encoder_spec` field. The supported formats are:

```
openai-clip:ViT-B/32
open-clip:ViT-L-14/dfn2b_s39b
siglip:google/siglip2-large-patch16-256
```

Other OpenCLIP `model/pretrained` pairs and other SigLIP HuggingFace IDs will work too, as long as the underlying packages support them. Custom values appear in the dropdown labeled "(custom)" so they're not silently overwritten when you edit the album.

## Tuning for Effective Search

After picking the encoder and indexing, the next step is search tuning. Each album also stores a *minimum search score*, a *maximum results* count, and a *query optimization* toggle, all editable from the search dialog itself. See [Search](search.md#tuning-search-per-album) for the details — the right values can vary substantially by encoder and by the kind of images in the album.
