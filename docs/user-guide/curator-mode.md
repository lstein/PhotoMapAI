# Curator Mode

Curator Mode is a powerful feature in PhotoMapAI designed to help you select a diverse or representative subset of images from a large album. This is particularly useful for creating training datasets for LoRA (Low-Rank Adaptation) models or simply thinning out a large collection using CLIP embeddings as the driver.

![Curator Mode Panel](../img/curator-panel.png)

## Accessing Curator Mode

1.  Open an album in the grid view.
2.  Click the **Curate** button floating in the bottom-right corner of the screen.

## Selection Algorithms

Curator Mode offers two distinct algorithms for selecting images:

### Diversity (FPS)
**Farthest Point Sampling** selects images that are as different from each other as possible.
-   **Best for:** Ensuring your dataset covers the widest possible range of visual concepts, lighting conditions, and angles.
-   **When to use:**
    -   **High Quality Data:** FPS seeks outliers. In a "dirty" dataset, outliers are often blurry or broken images. In a "clean" dataset, outliers are your rare concepts (side profiles, dramatic lighting).
    -   **Unbalanced Data:** If you have 50 full-body images and 10 close-ups, FPS will prioritize the close-ups to ensure the AI learns the rare concept, rather than just the common one.
-   **How it works:** It starts with a random image (or your excluded selection) and iteratively picks the image whose feature vector is farthest from the current set.

### Blocks (K-Means)
**K-Means Clustering** groups images into clusters and picks a representative image from each cluster.
-   **Best for:** Reducing redundancy while maintaining the overall distribution of the dataset (Representative Sampling).
-   **When to use:**
    -   **Balanced Distribution:** If you have 50 full-body images and 10 close-ups, K-Means will select roughly 5 full-body images for every 1 close-up, preserving the original ratios of your dataset.
-   **How it works:** It divides your images into N clusters (where N is your target count) and selects the image closest to the mathematical center of each cluster.



## Workflow
1.  **Setup your UI**: Recommend setting Cluster Strength to 0.001, and turning off "Show landmarks", "Show hover thumbnails" and "Highlight selection" for a clean initial view.
![Curator Mode Setup](../img/curator-setup.png)
2.  **Set Target Count**: Choose how many images you want in your final set (e.g., 50, 150).
3.  **Set Iterations**: 
    -   Algorithms like FPS can be sensitive to the starting point. Running multiple iterations (Monte Carlo simulation) helps identify the "consensus" selections—images that are statistically important regardless of the random start.
    -   **Recommendation:** Set to 20 iterations for analysis.
4.  **Run Preview**: Click **Preview** to run the simulation.

![Curator Mode Preview](../img/curator-preview.png)

### Stability Heatmap
The results are displayed as a Stability Heatmap:
-   🟣 **Magenta**: Core Outliers (Selected in >90% of runs). These are your most mathematically unique images.
-   🔵 **Cyan**: Stable (Selected in >70% of runs).
-   🟢 **Green**: Variable (Selected in <70% of runs). Edge cases that usually fill gaps.

Unselected images will be dimmed.

## Refinement & Exclusion
You can manually refine the selection by "Excluding" images. Excluding an image removes it from calculations and exports.

This allows for a "Drill Down" workflow:
1.  Run the analysis.
2.  If the top results (Magenta) are garbage (e.g., blurry images), Exclude them.
3.  Run Preview again. The algorithm is forced to ignore the excluded images and find the next best candidates.

-   **Click-to-Exclude**: Toggle this mode and click images in the grid (or UMAP) to exclude/include them. Excluded images appear with a **Red Border**.
-   **Exclude Matches**: Bulk-exclude all images that meet a certain frequency threshold (e.g., >90%).
-   **Clear Exclusions**: Clear all exclusions and restart the analysis.

![Exclusion Example](../img/curator-exclusion.png)

## Recommended Workflows

### Scenario A: Cleaning a Dataset (Removing Garbage)
1.  Set **Target Count** to 20. Set **Iterations** to 20.
2.  Run **Preview** (FPS).
3.  Look at the **Magenta** (>90%) results. Since FPS hunts for outliers, these will be your "weirdest" images.
4.  If they are broken/blurry, click **Exclude Matches** (or exclude manually).
5.  Repeat until the preview shows only high-quality images.
    *   *Note: Do not export yet. You are just identifying what to ignore.*

### Scenario B: Generating a Training Set
1.  Clear any previous selections (keep exclusions if you identified garbage in Scenario A).
2.  Set **Target Count** to your desired training size (e.g., 150).
3.  Set **Iterations** to 20.
4.  Run **Preview**.
5.  Review the selection. If you see images you don't want in your LoRA, **Exclude** them and run Preview again to replace them with fresh alternatives.
6.  **Export Dataset**.

## Exporting
![Ready To Export Example](../img/curator-readytoexport.png)
Once you are satisfied with your selection (Magenta/Cyan/Green images):
1.  Enter an **Export Path** (e.g., `C:/Training/MyDataset`).
2.  Click **Export Dataset**.
3.  The system will copy the selected images (and associated text files) to the folder.
4.  You can also press the CSV button to export data on the included ane excluded files.

*   *Note: Text is also exported! If you have 0001.jpg and 0001.txt in the album, they will be exported together.*
*   *Note: Excluded (Red) images are NOT exported.*
*   *Note: Filename collisions (e.g. apple/01.jpg vs orange/01.jpg) are automatically handled by renaming.*

### Contact /u/AcadiaVivid on reddit or NMWave on github for more info on implementation.