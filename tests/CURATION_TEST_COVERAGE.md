# Curation Functionality Test Coverage

This document describes the comprehensive test coverage added for the curation panel functionality in PhotoMapAI.

## Overview

The curation functionality (Model Training Dataset Curator) is a feature that helps users select representative images from their collection for training AI models. It uses algorithms like Farthest Point Sampling (FPS) and K-Means clustering with Monte Carlo iterations to select diverse and representative images.

## Test Summary

- **Total Backend Tests Added**: 13
- **Total Frontend Tests Added**: 30
- **Overall Test Suite**: 211 frontend tests, 34 backend tests
- **All Tests Passing**: ✅ Yes

## Backend Tests (`tests/backend/test_curation.py`)

### 1. Synchronous Curation Tests
- `test_curate_sync_endpoint`: Tests the `/api/curation/curate_sync` endpoint with both FPS and K-Means methods
- `test_curate_sync_with_exclusions`: Tests that excluded indices are properly respected during curation
- `test_curate_sync_validation`: Tests parameter validation (negative/zero/excessive target_count, invalid album)
- `test_curate_multiple_iterations`: Tests curation with multiple Monte Carlo iterations for consensus
- `test_curate_analysis_results_format`: Validates the structure and format of analysis results

### 2. Asynchronous Curation Tests
- `test_curate_async_endpoint`: Tests the async `/api/curation/curate` endpoint with progress polling
- `test_curate_async_validation`: Tests validation of async curation parameters
- `test_curate_async_iterations_capped`: Verifies that iterations are capped at the maximum (30)
- `test_progress_nonexistent_job`: Tests error handling for invalid job IDs

### 3. Export Functionality Tests
- `test_export_endpoint`: Tests the `/api/curation/export` endpoint for exporting selected images
- `test_export_validation`: Tests validation of export parameters (empty path, invalid path)
- `test_export_path_traversal_protection`: Verifies security protection against path traversal attacks
- `test_export_nonexistent_files`: Tests handling of nonexistent files during export

## Frontend Tests (`tests/frontend/curation-functionality.test.js`)

### 1. UI Component Tests
- Panel toggle functionality
- Slider synchronization between range and number inputs
- Button state management (disabled/enabled states)
- Status message display with proper color coding

### 2. Parameter Validation Tests
- Export path validation (empty/non-empty paths)
- Method selection (FPS vs K-Means)
- Iterations validation (capping at 30, minimum of 1)
- localStorage integration for export path persistence

### 3. Progress Tracking Tests
- Progress bar display and updates
- Progress percentage updates during async operations
- Progress bar hiding after completion

### 4. Exclusion/Locking Tests
- Exclusion count display updates
- Exclude mode toggle button state changes
- Threshold-based exclusion logic
- Clear exclusions functionality

### 5. Export Functionality Tests
- CSV header format validation
- CSV value escaping for special characters
- CSV row formatting with proper data types
- Export button state based on path and selection

### 6. Async Operation Tests
- Successful curation start with job ID
- Progress polling with "running" status
- Progress polling with "completed" status
- Error handling with "error" status

### 7. Frequency-Based Categorization Tests
- High frequency items (≥90%)
- Medium frequency items (70-89%)
- Low frequency items (<70%)

## Test Coverage by Feature

### Core Curation Features
✅ FPS (Farthest Point Sampling) algorithm  
✅ K-Means clustering algorithm  
✅ Monte Carlo iterations for consensus  
✅ Exclusion/locking of specific images  
✅ Threshold-based exclusion  

### API Endpoints
✅ `/api/curation/curate` - Async curation with progress tracking  
✅ `/api/curation/curate/progress/{job_id}` - Progress polling  
✅ `/api/curation/curate_sync` - Synchronous curation  
✅ `/api/curation/export` - Export selected images  

### UI Components
✅ Curation panel toggle  
✅ Target count slider and number input  
✅ Iterations input  
✅ Method selection (radio buttons)  
✅ Run/Clear/Export/CSV buttons  
✅ Export path input with validation  
✅ Progress bar  
✅ Status messages  
✅ Exclusion controls  

### Data Integrity
✅ Analysis results format (filename, subfolder, count, frequency, index)  
✅ Frequency percentage calculation (0-100%)  
✅ CSV export format with proper escaping  
✅ Selected indices and files synchronization  

### Security
✅ Path traversal protection for exports  
✅ Export restricted to user home directory  
✅ Input validation for all parameters  
✅ Error handling for malformed requests  

## Running the Tests

### Frontend Tests
```bash
npm install
npm test
```

To run only curation tests:
```bash
npm test -- tests/frontend/curation-functionality.test.js
```

### Backend Tests
```bash
pip install -e ".[testing]"
pytest tests/backend/test_curation.py -v
```

To run all backend tests:
```bash
pytest tests/backend -v
```

## Test Quality Notes

1. **Isolation**: Tests use fixtures and temporary directories to ensure isolation
2. **Cleanup**: All tests properly clean up resources (albums, files, temp directories)
3. **Realistic**: Tests use actual image files and perform real index creation
4. **Comprehensive**: Tests cover success paths, error paths, edge cases, and validation
5. **Fast**: Frontend tests run in ~2.5 seconds, backend curation tests in ~40 seconds
6. **Maintainable**: Clear test names and documentation make tests easy to understand and maintain

## Future Test Enhancements

Potential areas for additional testing:
- Integration tests combining frontend and backend
- Performance tests with large image collections
- UI interaction tests using Playwright or similar
- Load testing for concurrent curation operations
- Tests for specific algorithm behavior and convergence

## Conclusion

The curation functionality now has comprehensive test coverage including:
- 13 backend tests covering all API endpoints and edge cases
- 30 frontend tests covering UI components, validation, and user interactions
- Security tests for path traversal protection
- Async operation tests with progress polling
- Data format and integrity validation

All tests are passing and integrated into the existing test suite.
