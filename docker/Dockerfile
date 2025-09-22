# WARNING: This Dockerfile builds the demo version of PhotoMapAI, in which
# the album is locked to "demo" and all album management features are disabled.
# Use an official Python base image
FROM python:3.11-slim

WORKDIR /app

# Copy requirements and install Python dependencies
COPY pyproject.toml .
COPY photomap ./photomap
RUN pip install --upgrade pip && pip install --extra-index-url https://download.pytorch.org/whl/cpu .
RUN python -c "import clip; clip.load('ViT-B/32')"

RUN pip cache purge
RUN rm -rf ./photomap ./build ./dist ./demo_images/photomap_index/

# Expose the port your app runs on
EXPOSE 8050

# Start the server
ENTRYPOINT ["python3", "-mphotomap.backend.photomap_server"]
CMD ["--host", "0.0.0.0", "--port", "8050"]
