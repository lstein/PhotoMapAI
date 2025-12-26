# Bookmarks

The Bookmarks feature allows you to mark images for later access and perform batch operations on them. Bookmarks are stored per album and persist across browser sessions.

## Adding and Removing Bookmarks

You can bookmark an image in several ways:

- **Star icon**: Click the star icon that appears in the corner of any image, either in the single-slide browsing view or in the grid view.
- **Keyboard shortcut**: Press the `b` key to toggle the bookmark on the currently displayed image.

When an image is bookmarked, its star icon turns yellow to indicate its bookmarked status.

## The Bookmarks Menu

When you have bookmarked at least one image, the bookmark icon in the search panel (at the bottom of the screen) will turn yellow and display the number of bookmarked images. Click this icon to open the bookmarks menu with the following options:

- **Show**: Display only bookmarked images as search results. This allows you to quickly review all your bookmarked images. Clicking this again will clear the filter.
- **Clear**: Remove all bookmarks from the current album.
- **Select All**: Available when viewing search results, this option bookmarks all images in the current search results.
- **Curate**: Open the image dataset curator panel. See [Dataset Curation](curator-mode)
- **Move**: Move the selected files to a new location on the machine the PhotoMapAI backend is running on. If the destination is not one of the golder belonging to the current album, you will be asked if you want to add the destination folder to the album.
- **Export**: Copy the selected files to a new location on the machine the PhotoMapAI backend is running on. The album will not be altered.
- **Download**: Download all bookmarked images. A single image downloads directly, while multiple images are bundled into a ZIP file. Use this when PhotoMapAI is running on a remote machine and you want to copy some or all of its images locally. Note that when downloading a large number of images there may be significant wait for the archiving operation to complete.
- **Delete**: Permanently delete all bookmarked images from the album and disk (after confirmation).

## Use Cases

Bookmarks are useful in many scenarios:

- **Curating photos**: Mark your favorite photos from a large collection for sharing or printing.
- **Batch downloading**: Select multiple images across your album and download them all at once.
- **Organizing**: Use bookmarks with search to find specific images, then select all matching results to perform batch operations.
- **Cleanup**: Mark images for deletion and remove them all at once.

## Persistence

Bookmarks are saved in your browser's local storage and are specific to each album. When you switch albums, the bookmarks for that album are loaded. Bookmarks persist across browser sessions, so you can close PhotoMapAI and return later to find your bookmarks intact.
