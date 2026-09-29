# Running from a Docker Image

You can run PhotoMapAI from a image registered with [DockerHub](https://hub.docker.com/explore). Alternatively, you can build and customize [Docker](https://docker.com) image from PhotoMapAI's source code.

## Running from DockerHub

There are two versions of PhotoMapAI available on DockerHub. The first, `photomapai-demo` is a demo version that comes prepackaged with a series of copyright-free images from [Open Images](https://storage.googleapis.com/openimages/web/index.html). In this version, the ability to add, remove and edit albums has been disabled, as well as the ability to set the LocationIQ API key that is used to generate map thumbnails to display photograph GPS metadata. (Because LocationIQ grants licenses for personal use, this key cannot be incorporated into a public demo.)

The second image is `photomapai`. This is the full-featured version of the application, that comes without any pre-configured albums. 

Assuming you have [Docker](https://docker.com installed on your system, run the following command to launch the demo version:

```
docker run -p 8050:8050 lstein/photomapai-demo:latest
```

This will download the latest version of PhotoMapAI from DockerHub and run it, while mapping your desktop's network port 8050 to port 8050 running inside the container. You will see some startup messages. When they finish, point your browser to http://localhost:8050. You will see the PhotoMapAI user interface.

Running the full version is almost as easy:

```
docker run -p 8050:8050 -v /path/to/my/pictures:/Pictures lstein/photomapai:latest
```

The additional `-v` option maps a folder on your desktop machine to the `/Pictures` folder in the container. Replace `/path/to/my/pictures` with the appropriate folder path on your system. You may provide multiple `-v` options to map more directories. Once PhotoMapAI is running, point your browser to http://localhost:8050 and proceed to define an album as described in [Managing Albums](user-guide/albums.md).

You may find earlier versions of PhotoMapAI on DockerHub. Just do `docker search photomapai` to see all the available versions.

## Video Support

The PhotoMapAI Docker images do **not** include [ffmpeg](https://ffmpeg.org), the program PhotoMapAI uses to index videos and to convert videos that your browser can't play. (The ffmpeg build that comes with a normal PhotoMapAI installation is GPL-licensed, so it's removed from the published images rather than redistributed with them.) Photos work exactly as usual, but video files in your albums are skipped during indexing, and PhotoMapAI shows a message saying that it could not find a working ffmpeg.

!!! note "Installing ffmpeg on your computer won't help the container"
    A Docker container only sees programs inside its own image. An ffmpeg installed on your Linux, macOS or Windows desktop is invisible to it, so installing one there won't enable video in the container. The system ffmpeg instructions in [Video support and ffmpeg](installation.md#video-support-and-ffmpeg) apply when you run PhotoMapAI directly on your computer, not in Docker.

To handle videos in Docker, build your own image on top of the published one and add ffmpeg inside it. Create an empty folder, and in it a file named `Dockerfile` containing:

```dockerfile
FROM lstein/photomapai:latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
```

Then build and run it from that folder:

```
docker build -t photomapai-video .
docker run -p 8050:8050 -v /path/to/my/pictures:/Pictures photomapai-video
```

The image is based on Debian, and this installs Debian's ffmpeg package, which PhotoMapAI finds automatically. Videos that were skipped earlier are picked up the next time you run **Update Index** on the album. Debian's ffmpeg is itself GPL-licensed. That doesn't matter for your own use, but if you publish the resulting image you take on the GPL's obligations for it.

Alternatively, skip Docker for video-heavy albums: the [desktop installer](installation.md#recommended-the-desktop-installer) and the [PyPI install](installation.md#alternative-install-from-pypi) both include a working ffmpeg automatically.

## Building a Customized Docker Image

To build a customized image, you will need the PhotoMapAI source code. Download the zip or tar source code file from [GitHub](https://github.com/lstein/PhotoMapAI) and unpack it. You will find two Docker build files in the `docker` folder, `Dockerfile` and `Dockerfile.demo`. The first builds the full application, and the second builds the demo version.

To build the full application, run this command from inside the root of the source code repository (the one with README.md):

```
docker build -f docker/Dockerfile -t photomapai
```

This will build the image and register it locally. You can then run it with `docker -p 8050:8050 photomapai`.

Building the demo version is almost the same, except that you have the option of preloading a collection of images for the demo. To do this, locate the (empty) `demo_images` folder in the source code repository, and copy a series of images into it. Then build the demo image with this command:

```
docker build -f docker/Dockerfile.demo -t photomapai-demo
```

The image will be built as before, but now you should see messages about loading and indexing the demo images.