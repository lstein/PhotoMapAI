#!/usr/bin/env python3

import time
import torch
import clip
from PIL import Image
import numpy as np

ITERATIONS = 100

# Load model once for both devices
def benchmark_clip_encode(device):
    model, preprocess = clip.load("ViT-B/32", device=device)
    model.eval()

    # Create a random image and preprocess it
    img = Image.fromarray(np.random.randint(0, 255, (224, 224, 3), dtype=np.uint8))
    image_tensor = preprocess(img).unsqueeze(0).to(device)

    # Warm-up
    with torch.no_grad():
        _ = model.encode_image(image_tensor)

    # Benchmark
    start = time.time()
    with torch.no_grad():
        for _ in range(ITERATIONS):
            _ = model.encode_image(image_tensor)
    end = time.time()
    avg_time = (end - start) / ITERATIONS
    print(f"Device: {device}, Avg encode_image time: {avg_time:.4f} seconds")

if __name__ == "__main__":
    print("Benchmarking CLIP.encode_image()")
    benchmark_clip_encode("cpu")
    if torch.cuda.is_available():
        benchmark_clip_encode("cuda")
    else:
        print("CUDA not available.")
