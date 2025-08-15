#Semantic Map

The PhotoMap semantic map is a graphical representation of the relationships among all the photos/images in an album. Each image is represented by a dot. Images that are similar will be closer together on the map than dissimilar images. The semantic map is linked to the main image display. The location of the current image is shown on the semantic map as a yellow target icon. Clicking on an image dot anywhere in the map will bring the full-resolution photo/image into view in the main display. Hovering over an image dot will pop up a thumbnail of the image, allowing you to rapidly explore the image landscape.

<img src="/img/photomap_semantic_map_umap_only.png">

## The Clustering Process

The semantic map is generated in two phases. In the first phase, which is performed when the album's index is created or updated, each image is compressed into a high-dimensional representation of its contents called an "embedding." The embeddings are then projected onto a 2D X-Y plot using the [UMAP dimensionality-reduction algorithm](https://umap-learn.readthedocs.io/en/latest/how_umap_works.html). UMAP is able to preserve the topological relationships among embeddings. Two embedding points that are close together on the UMAP are more semantically similar than two that are far apart.

In the second phase, PhotoMap applies an algorithm known as DBSCAN [Density-Based Spatial Clustering of Applications with Noise](https://en.wikipedia.org/wiki/DBSCAN) to partition the map into multiple clusters of highly-related images. Each cluster is then assigned an arbitrary color for visualization. The clustering process is quick and happens automatically the first time you open the semantic map window on a particular album.

### Tuning Clusters

The overall topology of the semantic map is fixed during the indexing process, but the clustering phase can be adjusted on the fly. At the bottom of the semantic map window is a field labeled "Cluster Strength," and contains a floating point value ranging from 0.0 to 1.0. This parameter (technically called epsilon, or "eps") controls the clustering size. Higher values of eps will create a smaller number of large clusters, while lower values will create a larger number of small clusters.

<img src="/img/photomap_semantic_map_eps.png" width="480" class="img-hover-zoom">

The default value of eps is 0.07, which empirically seems to work well for collections of a few tens of thousands of photographs. For smaller collections, you may wish to increase eps to 0.1 through 0.5. If the eps is too low, you may also see a lot of unclustered images, which are represented as faint gray dots. If you initially don't see much when you pull up the semantic map, gradually increase the "Cluster Strength" field until the display is satisfactory.

### Interpreting Clusters

What does "semantically similar" mean? Embeddings capture many different aspects of an image, ranging from low-level features such as brightness and color palette, to high-level features such as particular people and places. This can lead to interesting appositions. For example, say you have three photos depicting (1) Mary at the playground; (2) Mary at a birthday party; and (3) Timmy at a birthday party. (1) and (2) will mapped close together because they share the same subject, Mary. (2) and (3) will be close together because they share the same event, a birthday party. Because of these relationships, (1) and (3) will also likely be close together as well, but further apart than either of the other two pairs.

Therefore you will find clusters that contain a mixture of relationships. Sometimes you will find yourself scratching your head to figure out why several images cluster together, but more often you'll discover delightfully unexpected groupings. For example, my family photo collection contains clusters corresponding to "kids climbing trees," "pets yawning," and "weddings on the maternal side of the family."

## Navigating the Map

When you first open the map it will be zoomed almost all the way out. You will likely wish to increase the zoom level in order to see more detail. This is intuitive when using a mouse. The scrollwheel will zoom in and out, while clicking and dragging on the map will move the map around (panning). 

<img src="/img/photomap_semantic_map_umap_navigation_bar.png" width="480" alt="Semantic Map" class="img-hover-zoom">

There is also a navigation bar at the top of the plot that appears when you hover over it. From left to right, the icons have the following functions:

- **Camera Icon** - Snapshot the current map and save it to disk as a PNG image.
- **Magnifier Icon** - Outline a rectangular region of the map and zoom into it.
- **NSEW Arrows Icon** - Pan the image (default behavior).
- **+ and - icons** - Zoom in and zoom out.
- **Crossed Arrows Icon** - Zoom out until the entire map is in view.
- **Home Icon** - Reset view to the default.
- **Plotly Icon** - Advertisement for the plotting package used to plot the map.

On tablet devices, the best way to zoom into an area of interest is to use the magnifier icon and/or a combination of the pan tool and the Zoom in/out icons.

## Moving the Map Window

The map window can be repositioned anywhere on the screen by clicking and dragging on its titlebar. In addition it can be resized by clicking the resize icons shown in the screenshot below (mouse over to see the legend).

<div class="photomap-overlay-container">
  <img src="/img/photomap_semantic_map_sizing_base.png" width="480" class="photomap-base" alt="Base image">
  <img src="/img/photomap_semantic_map_sizing_overlay.png" width="480" class="photomap-overlay" alt="Overlay image">
</div>

The sizes shown are approximate and are adjusted for different size browser windows. The full-screen size (the leftmost icon) covers the entire window and is opaque. Other sizes are slightly transparent to allow you to see the full-size images beneath.

The shade icon (rightmost) collapses the window so that only the titlebar is visible. This is convenient for temporarily uncluttering the screen.
