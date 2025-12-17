# Move Images Feature Implementation

## Overview
This implementation adds the ability to move bookmarked images to a different folder on the filesystem, both from the image view (swiper) and grid view.

## Implementation Details

### Backend Changes

#### 1. `photomap/backend/routers/index.py`
- Added `MoveImagesRequest` Pydantic model to handle move requests with indices and target directory
- Added `POST /move_images/{album_key}` endpoint that:
  - Validates the target directory exists and is writable
  - Checks for duplicate files in target directory
  - Detects files already in target folder
  - Moves files using `shutil.move()`
  - Updates embeddings index with new paths
  - Returns detailed results including moved files, errors, and same-folder files

#### 2. `photomap/backend/embeddings.py`
- Added `update_image_path(index, new_path)` method that:
  - Updates the filename in the embeddings array
  - Saves the updated embeddings file
  - Clears the LRU cache to ensure fresh data

### Frontend Changes

#### 1. `photomap/frontend/static/javascript/filetree.js`
- Enhanced `createSimpleDirectoryPicker()` to accept an `options` parameter
- Added support for custom:
  - Button label (default: "Add", can be "Move")
  - Dialog title (default: "Select Directory")
  - Path label (default: "Current directory to add:")
- Updated convenience function to pass through options

#### 2. `photomap/frontend/static/javascript/bookmarks.js`
- Added `MOVE_SVG` icon for the move button
- Added `moveBookmarkedImages()` method that:
  - Gets the current folder from the first bookmarked image
  - Opens directory picker with "Move" button label
  - Calls `performMove()` when directory is selected
- Added `performMove(indices, targetDirectory)` method that:
  - Sends POST request to `/move_images/{album_key}`
  - Displays detailed results with success count, errors, and same-folder files
  - Triggers album refresh if files were moved
- Added Move button to the bookmark menu between Download and Delete

### Test Coverage

#### `tests/backend/test_index.py`
Added comprehensive test cases:
1. `test_move_images()` - Tests successful move operation
2. `test_move_images_to_same_folder()` - Tests moving to same folder (should skip)
3. `test_move_images_nonexistent_directory()` - Tests error handling for invalid directory
4. `test_move_images_file_exists()` - Tests conflict when file already exists in target

## User Flow

### Using the Feature
1. User bookmarks one or more images by clicking the star icon (in swiper or grid view)
2. User clicks the Bookmarks button in the search panel
3. In the bookmark menu, user clicks "Move"
4. A directory picker appears showing:
   - Current location (first bookmarked image's directory)
   - Option to show hidden directories
   - Navigation: single-click to select, double-click to enter
5. User navigates to desired destination folder
6. User clicks "Move" button
7. Confirmation dialog shows:
   - Number of files successfully moved
   - Any files already in target folder (skipped)
   - Any errors (permission issues, duplicate names, etc.)

### Error Handling
The implementation handles several error scenarios:

1. **Target directory doesn't exist**: Returns 400 error
2. **Target directory not writable**: Returns 403 error
3. **File already in target folder**: Skips the file, reports in same_folder_files
4. **File with same name exists in target**: Skips the file, reports in errors
5. **Access denied for specific file**: Skips the file, reports in errors

## Manual Testing Procedure

### Prerequisites
1. Start the PhotoMapAI server with an album containing images
2. Open the web interface in a browser

### Test Case 1: Basic Move Operation
1. Bookmark 2-3 images from different folders
2. Click Bookmarks button
3. Click Move button
4. Navigate to a new folder
5. Click Move
6. **Expected**: Success message showing number of moved files
7. **Verify**: Files are in new location and still accessible

### Test Case 2: Move to Same Folder
1. Bookmark an image
2. Click Move
3. Select the same folder the image is already in
4. Click Move
5. **Expected**: Message indicating files already in target folder

### Test Case 3: File Name Conflict
1. Bookmark an image
2. Manually copy that image to a test folder
3. Try to move the bookmarked image to the test folder
4. **Expected**: Error message about file already existing

### Test Case 4: Permission Error
1. Bookmark an image
2. Try to move to a read-only directory (if available)
3. **Expected**: Error about directory not being writable

### Test Case 5: Cancel Operation
1. Bookmark images
2. Click Move
3. Click Cancel in directory picker
4. **Expected**: No changes made, menu closes

### Test Case 6: Move Multiple Images from Grid View
1. Switch to grid view
2. Bookmark 5+ images by clicking star icons
3. Click Bookmarks button
4. Click Move
5. Select destination folder
6. **Expected**: All bookmarked images moved successfully

## API Documentation

### POST /move_images/{album_key}

**Request Body:**
```json
{
  "indices": [0, 1, 2],
  "target_directory": "/path/to/destination"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "moved_count": 2,
  "moved_files": ["image1.jpg", "image2.jpg"],
  "same_folder_count": 1,
  "same_folder_files": ["image3.jpg"],
  "error_count": 0,
  "errors": []
}
```

**Error Responses:**
- `400`: Target directory does not exist or is not a directory
- `403`: Target directory is not writable or album is locked
- `500`: Internal server error

## Integration with Existing Features

The move feature integrates seamlessly with:
- **Bookmark system**: Uses existing bookmark storage and management
- **Directory picker**: Enhances existing filetree.js with custom labels
- **Album refresh**: Triggers existing album update mechanism
- **Spinner/loading**: Uses existing UI feedback system
- **Embeddings index**: Updates paths using new `update_image_path()` method

## Code Quality

- ✅ Python syntax validated
- ✅ JavaScript syntax validated
- ✅ Follows existing code patterns
- ✅ Comprehensive error handling
- ✅ Backend tests added
- ✅ Minimal changes to existing code
- ✅ Backward compatible (no breaking changes)

## Future Enhancements (Out of Scope)

Possible future improvements:
1. Batch move with progress indicator for large numbers of files
2. Move with rename option to handle duplicates
3. Undo/redo functionality
4. Move history tracking
5. Keyboard shortcut for move operation
