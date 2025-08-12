# Basic Usage

PhotoMap is organized into a series of photo albums. Each album is a collection of images on the local machine or a shared drive.

## Creating an album

The first time you launch PhotoMap it will prompt you to create an album with the screen shown below.

<img src="/img/photomap_album_setup.png" width="640" alt="Album creation dialogue" class="img-hover-zoom">

Enter a short lowercase key for the album, such as "family", a longer descriptive name such as "Family Photos 2025", and optionally a description of the album. (The key can be used in URLs if you wish to share a particular album in a text or email message as [described here](albums#selecting_an_album_by_its_url)).

You'll now need to tell the album where its photos are stored. Enter one or more filesystem paths in the text field at the bottom named "Image Paths". Photos can be stored in a single large folder, or stored in multiple nestered folders. They can reside on the local disk or on a shared disk. If you wish, you can point the album to multiple folders, and their contents will be combined into a single album.

PhotoMap supports photos in JPEG or PNG format. Support for Apple's HEIC/HEIF formats is currently a work in progress.

The screenshot below shows the dialogue after populating it on a Linux or MacOS system. On Windows systems use the usual `C:\path\to\directory` notation.

<img src="/img/photomap_album_setup_filled.png" width="480" alt="Album creation dialogue" class="img-hover-zoom">

Once the album is set up to your liking, press the `Add Album` button at the bottom left and indexing will start:

<img src="/img/photomap_album_setup_indexing.png" width="3480" alt="Album indexing" class="img-hover-zoom">

Indexing can take some time. On a system equipped with an NVidia GPU, indexing a collection of ~50,000 images will take about two hours. On a system with CPU only, the process will take overnight. Mac users with hardware accelerated M1/2/3 chips will see performance somewhere in between the two. It is suggested to start with a small collection of photos (~1000) for your first album in order to test PhotoMap and get comfortable with its features.

Once indexing is complete, the dialogue will close and you can start exploring your collection.