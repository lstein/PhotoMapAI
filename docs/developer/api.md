# PhotoMapAI API Reference

PhotoMapAI is driven by a Pydantic data model and a series of FastAPI endpoints. You may access and test these endpoints using [http://localhost:8050/docs](http://localhost:8050/docs)

## Album Management Endpoints

### `GET /available_albums/`
**Description:**  
Returns a list of all available albums.

**Response:**  
- `200 OK`: List of album metadata (`key`, `name`, `description`, `index`, `umap_eps`, `image_paths`).

---

### `GET /album/{album_key}/`
**Description:**  
Get details for a specific album.

**Parameters:**  
- `album_key` (string): Album identifier.

**Response:**  
- `200 OK`: Album object.
- `404 Not Found`: If album does not exist.

---

### `POST /add_album/`
**Description:**  
Add a new album.

**Body:**  
- Album object (Pydantic model).

**Response:**  
- `201 Created`: Success message.
- `409 Conflict`: If album already exists.

---

### `POST /update_album/`
**Description:**  
Update an existing album.

**Body:**  
- Album data as a dictionary.

**Response:**  
- `200 OK`: Success message.
- `404 Not Found`: If album does not exist.

---

### `DELETE /delete_album/{album_key}`
**Description:**  
Delete an album.

**Parameters:**  
- `album_key` (string): Album identifier.

**Response:**  
- `200 OK`: Success message.
- `404 Not Found`: If album does not exist.

---

### `GET /locationiq_key/`
**Description:**  
Get the masked LocationIQ API key.

**Response:**  
- `200 OK`: Masked API key or indication that no key is set.

---

### `POST /locationiq_key/`
**Description:**  
Set the LocationIQ API key.

**Body:**  
- `{ "api_key": "..." }`

**Response:**  
- `200 OK`: Success or error message.

---

### `POST /set_umap_eps/`
**Description:**  
Set the UMAP clustering epsilon for an album.

**Body:**  
- `{ "album": "album_key", "eps": float }`

**Response:**  
- `200 OK`: Success message and new epsilon value.
- `404 Not Found`: If album does not exist.

---

### `POST /get_umap_eps/`
**Description:**  
Get the UMAP clustering epsilon for an album.

**Body:**  
- `{ "album": "album_key" }`

**Response:**  
- `200 OK`: Current epsilon value.
- `404 Not Found`: If album does not exist.

---

## UMAP Endpoints

### `GET /umap_data/{album_key}`
**Description:**  
Get UMAP embedding data and DBSCAN cluster labels for an album.

**Parameters:**  
- `album_key` (string): Album identifier  
- `cluster_eps` (float, optional): DBSCAN epsilon  
- `cluster_min_samples` (int, optional): DBSCAN min_samples

**Response:**  
- `200 OK`: List of points with `x`, `y`, `index`, `cluster`.
- `404 Not Found`: If album or embeddings not found.

---

## Search Endpoints

### `POST /search_with_text_and_image/{album_key}`
**Description:**  
Search images by text and/or image similarity.

**Parameters:**  
- `album_key` (string): Album identifier

**Body:**  
- `positive_query` (string)
- `negative_query` (string)
- `image_data` (base64 string)
- `image_weight` (float)
- `positive_weight` (float)
- `negative_weight` (float)
- `top_k` (int)

**Response:**  
- `200 OK`: List of results with `index` and `score`.

---

### `GET /retrieve_image/{album_key}/{index}`
**Description:**  
Get metadata for a specific image.

**Parameters:**  
- `album_key` (string)
- `index` (int)

**Response:**  
- `200 OK`: SlideSummary metadata.

---

### `GET /image_info/{album_key}/{index}`
**Description:**  
Get basic info for an image.

**Parameters:**  
- `album_key` (string)
- `index` (int)

**Response:**  
- `200 OK`: ImageData object.

---

### `GET /get_metadata/{album_key}/{index}`
**Description:**  
Download JSON metadata for an image.

**Parameters:**  
- `album_key` (string)
- `index` (int)

**Response:**  
- `200 OK`: JSON metadata.

---

### `GET /thumbnails/{album_key}/{index}`
**Description:**  
Get a thumbnail for an image.

**Parameters:**  
- `album_key` (string)
- `index` (int)
- `size` (int, optional)

**Response:**  
- `200 OK`: Image file.

---

### `GET /images/{album_key}/{path:path}`
**Description:**  
Serve an image file by path.

**Parameters:**  
- `album_key` (string)
- `path` (string)

**Response:**  
- `200 OK`: Image file.

---

### `GET /image_path/{album_key}/{index}`
**Description:**  
Get the file path for an image by index.

**Parameters:**  
- `album_key` (string)
- `index` (int)

**Response:**  
- `200 OK`: Path as plain text.

---

### `GET /image_by_name/{album_key}/{filename:path}`
**Description:**  
Serve an image by its filename.

**Parameters:**  
- `album_key` (string)
- `filename` (string)

**Response:**  
- `200 OK`: Image file.

---

## Index Management Endpoints

### `POST /update_index_async/`
**Description:**  
Start an asynchronous index update for an album.

**Body:**  
- `{ "album_key": "..." }`

**Response:**  
- `202 Accepted`: Success message and task ID.
- `409 Conflict`: If update already running.

---

### `DELETE /remove_index/{album_key}`
**Description:**  
Remove the embeddings index file for an album.

**Parameters:**  
- `album_key` (string)

**Response:**  
- `200 OK`: Success message.
- `404 Not Found`: If album or index does not exist.

---

### `GET /index_progress/{album_key}`
**Description:**  
Get progress of an index update.

**Parameters:**  
- `album_key` (string)

**Response:**  
- `200 OK`: ProgressResponse object.

---

### `DELETE /cancel_index/{album_key}`
**Description:**  
Cancel an ongoing index update.

**Parameters:**  
- `album_key` (string)

**Response:**  
- `200 OK`: Success message.
- `404 Not Found`: If no active operation.

---

### `GET /index_exists/{album_key}`
**Description:**  
Check if an index exists for an album.

**Parameters:**  
- `album_key` (string)

**Response:**  
- `200 OK`: `{ "exists": true/false }`

---

## Utility Functions

These are used internally by the API:

- `validate_album_exists(album_key)`: Raises HTTPException if album does not exist.
- `get_embeddings_for_album(album_key)`: Returns Embeddings instance for album.
- `validate_image_access(album_config, image_path)`: Checks if image path is allowed for album.

---

**Note:**  
All endpoints may return appropriate HTTP error codes on failure.  
Authentication and authorization are not described here; add as needed for your deployment.

**See the source code for request/response models and further details.**
