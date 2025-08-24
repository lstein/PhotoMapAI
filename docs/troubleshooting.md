#Troubleshooting

Here are some frequently-encountered issues and their resolutions.

## No images are showing up in my display

Make sure that you have configured and indexed a [photo album](user-guide/albums.md), that the directory(s) associated with the album contain valid images (JPEG, PNG, HEIC), and that the images are readable by your user account. Scroll to the album in question using the [Album Manager](user-guide/albums.md#managing-albums) and make sure that it has been indexed and that at least two images exist in the album. If necessary, reindex using the **Index** button.

If these attempts fail, send a bug report to the [PhotoMap Issues](https://github.com/lstein/PhotoMapAI/issues) page, copying any error messages you see in the browser's JavaScript console and the PhotoMapAI launch script window.

## Copy-and-Paste isn't working

When you try to copy some text from the image metadata drawer, you get a message that says "Clipboard API not available due to browser security restrictions. Please copy manually."

When a site is running under http (not https), browsers prevent the site's scripts from copying information into the system clipboard. You can fix this by running PhotoMapAI as an https service, either using self-signed certificates or behind an https-enabled reverse proxy as described in [Running PhotoMapAI under HTTPS](user-guide/configuration.md#running-photomapai-under-https)

## The semantic map is showing no clusters or too many clusters

This may be caused by two different issues:

### 1. The map is zoomed out too far

When first opened, the semantic map scales to show the positions of 98% of the images. If your photos/images are too diverse, this may end up squeezing the majority of images into a small central group. Try zooming into the group to see the fine-structured detail.

### 2. The clustering EPS needs to be tweaked

If even after zooming in you see either a handful of large clusters, or many small clusters and lots of unclustered (grey) dots, you may need to adjust the EPS (epsilon) parameter. Open the map window and find the EPS field. If you have too many clusters then increase the EPS value. This makes clustering more aggressive creating a smaller number of larger clusters. Alternatively, if you have too few clusters (or too many unclustered images), try lowering EPS.

It takes a moment for changes to EPS to take effect. The best strategy is to adjust it by small increments. For more information, see [Semantic Map](user-guide/semantic-map.md).