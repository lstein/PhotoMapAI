from backend.embeddings import Embeddings
from pathlib import Path

emb = Embeddings(embeddings_path='../test_embeddings.npz')
img_list = [Path('/net/cubox/CineRAID/Archive/InvokeAI/Yiffy/2023/9/aecd099f-1018-4892-8553-3616344a0195.png'),
            Path('/net/cubox/CineRAID/Archive/InvokeAI/Yiffy/2023/9/8dbdad32-e508-49c3-8f8b-d9c76268ed2d.png')]
next_file,metadata = emb.pick_image_from_list(img_list)
print(next_file, metadata)

next_file,metadata = emb.pick_image_from_list(img_list,
                                              next_file)
print(next_file, metadata)

next_file,metadata = emb.pick_image_from_list(img_list,
                                              next_file)
print(next_file, metadata)
