# Managing Albums

PhotoMap allows you to organize your photos and other images into a series of albums. Each album draws its images from one or more folders of images, and manages independent search indexes and semantic maps. Albums may also overlap by having some image paths in common -- with some restrictions.

## Adding and Deleting Albums

Bring up the Album Manager by clicking on the **Settings** gear icon and then the green **Manage Albums** button.

<img src="/img/photomap_settings.png" width="640">

The Album Management dialogue provides you with controls for creating new albums, editing existing ones, deleting unwanted albums, and bringing an album's contents up to date after you've added or removed image file from its folder paths.

<div class="photomap-overlay-container">
  <img src="/img/photomap_album_overview_base.png" width="480" class="photomap-base" alt="Base image">
  <img src="/img/photomap_album_overview_overlay.png" width="480" class="photomap-overlay" alt="Overlay image">
</div>

To add an album, press the green **Add Album** button. This will add a new section to the dialogue window that prompts you to enter the following fields:

- **Album Key** - This is a short mnemonic text that is used to uniquely identify the album. You can add it to PhotoMap's URL in order to go directly to the album of your choice, so it is best to avoid spaces and symbols. Once the key is assigned, you can't change it.
- **Display Name** - This is the name of the album that will be displayed in the settings Album popup menu and the browser tab window title.
- **Description** (optional) - A description of the album.
- **Image Paths** - One or more filesystem paths to the folders that contain image files to incorporate into the album.

<img src="/img/photomap_album_add.png" width="640" class="img-hover-zoom">

You are free to organize your image files in any way you wish. You can dump them into a single big folder, or organize them into multiple nested subfolders. During indexing, PhotoMap will traverse the folder structure and identify all image files. 


