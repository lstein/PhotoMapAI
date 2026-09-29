# Builds the full PhotoMapAI application (published as lstein/photomapai).
# The demo image, with its album locked to "demo", is built by Dockerfile.demo.
# Use an official Python base image
FROM python:3.11-slim

WORKDIR /app

# Copy requirements and install Python dependencies
COPY pyproject.toml .
COPY photomap ./photomap
COPY docker/scripts/remove_bundled_ffmpeg.py /tmp/
# The image deliberately ships without ffmpeg: imageio-ffmpeg bundles a GPLv3
# build, so it is deleted in this same layer (a later RUN would leave it in
# this one), and --no-cache-dir keeps the wheel out of pip's cache. See
# docs/docker.md for adding a distribution ffmpeg to restore video support.
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu . \
    && python /tmp/remove_bundled_ffmpeg.py \
    && rm /tmp/remove_bundled_ffmpeg.py
RUN python -c "import clip; clip.load('ViT-B/32')"

RUN rm -rf ./photomap ./build ./dist ./demo_images/photomap_index/

# Never try to open a browser from inside the container (also implied by the
# 0.0.0.0 bind, but set explicitly so it can't regress).
ENV PHOTOMAP_NO_BROWSER=1

# Expose the port your app runs on
EXPOSE 8050

# Start the server
ENTRYPOINT ["python3", "-mphotomap.backend.photomap_server"]
# Do not respawn the server after it exits. Do not allow inline upgrades into the docker image.
CMD ["--host", "0.0.0.0", "--port", "8050", "--once", "--no-inline-upgrade"]
