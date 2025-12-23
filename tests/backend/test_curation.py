"""
test_curation.py
Tests for the curation functionality (Model Training Dataset Curator).
"""

import os
import time
import tempfile
from pathlib import Path

import pytest
from fixtures import client, new_album, build_index


def test_curate_sync_endpoint(client, new_album, monkeypatch):
    """Test the synchronous curation endpoint."""
    # Build the index first
    build_index(client, new_album, monkeypatch)
    
    # Test FPS method
    response = client.post(
        "/api/curation/curate_sync",
        json={
            "target_count": 3,
            "iterations": 1,
            "album": new_album["key"],
            "method": "fps",
            "excluded_indices": []
        }
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    assert "selected_indices" in data
    assert "selected_files" in data
    assert "analysis_results" in data
    assert len(data["selected_indices"]) <= 3
    assert data["target_count"] == 3
    
    # Test K-means method
    response = client.post(
        "/api/curation/curate_sync",
        json={
            "target_count": 2,
            "iterations": 1,
            "album": new_album["key"],
            "method": "kmeans",
            "excluded_indices": []
        }
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    assert len(data["selected_indices"]) <= 2


def test_curate_sync_with_exclusions(client, new_album, monkeypatch):
    """Test curation with excluded indices."""
    build_index(client, new_album, monkeypatch)
    
    # First, run curation to get some indices
    response = client.post(
        "/api/curation/curate_sync",
        json={
            "target_count": 3,
            "iterations": 1,
            "album": new_album["key"],
            "method": "fps",
            "excluded_indices": []
        }
    )
    assert response.status_code == 200
    data = response.json()
    first_selection = data["selected_indices"]
    
    # Now exclude one of the selected indices
    if len(first_selection) > 0:
        excluded = [first_selection[0]]
        response = client.post(
            "/api/curation/curate_sync",
            json={
                "target_count": 3,
                "iterations": 1,
                "album": new_album["key"],
                "method": "fps",
                "excluded_indices": excluded
            }
        )
        assert response.status_code == 200
        data = response.json()
        # Verify that excluded index is not in the results
        assert excluded[0] not in data["selected_indices"]


def test_curate_sync_validation(client, new_album, monkeypatch):
    """Test validation of curation parameters."""
    build_index(client, new_album, monkeypatch)
    
    # Test negative target_count
    response = client.post(
        "/api/curation/curate_sync",
        json={
            "target_count": -5,
            "iterations": 1,
            "album": new_album["key"],
            "method": "fps",
            "excluded_indices": []
        }
    )
    # Expect 400 or 500 for validation errors
    assert response.status_code in [400, 500]
    
    # Test zero target_count
    response = client.post(
        "/api/curation/curate_sync",
        json={
            "target_count": 0,
            "iterations": 1,
            "album": new_album["key"],
            "method": "fps",
            "excluded_indices": []
        }
    )
    assert response.status_code in [400, 500]
    
    # Test excessive target_count
    response = client.post(
        "/api/curation/curate_sync",
        json={
            "target_count": 200000,
            "iterations": 1,
            "album": new_album["key"],
            "method": "fps",
            "excluded_indices": []
        }
    )
    assert response.status_code in [400, 500]
    
    # Test invalid album
    response = client.post(
        "/api/curation/curate_sync",
        json={
            "target_count": 3,
            "iterations": 1,
            "album": "nonexistent_album",
            "method": "fps",
            "excluded_indices": []
        }
    )
    # Album not found error is wrapped in 500
    assert response.status_code in [404, 500]


def test_curate_async_endpoint(client, new_album, monkeypatch):
    """Test the async curation endpoint with progress polling."""
    build_index(client, new_album, monkeypatch)
    
    # Start async curation
    response = client.post(
        "/api/curation/curate",
        json={
            "target_count": 3,
            "iterations": 2,
            "album": new_album["key"],
            "method": "fps",
            "excluded_indices": []
        }
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "started"
    assert "job_id" in data
    job_id = data["job_id"]
    
    # Poll for progress
    max_polls = 30
    poll_count = 0
    while poll_count < max_polls:
        response = client.get(f"/api/curation/curate/progress/{job_id}")
        assert response.status_code == 200
        progress_data = response.json()
        
        if progress_data["status"] == "completed":
            # Verify completion data
            assert "result" in progress_data
            result = progress_data["result"]
            assert result["status"] == "success"
            assert "selected_indices" in result
            assert len(result["selected_indices"]) <= 3
            break
        elif progress_data["status"] == "error":
            pytest.fail(f"Curation failed: {progress_data.get('error', 'Unknown error')}")
        elif progress_data["status"] == "running":
            # Check progress structure
            assert "progress" in progress_data
            progress = progress_data["progress"]
            assert "current" in progress
            assert "total" in progress
            assert "percentage" in progress
            assert "step" in progress
        
        time.sleep(0.5)
        poll_count += 1
    
    assert poll_count < max_polls, "Curation did not complete within timeout"


def test_curate_async_validation(client, new_album, monkeypatch):
    """Test validation of async curation parameters."""
    build_index(client, new_album, monkeypatch)
    
    # Test negative target_count
    response = client.post(
        "/api/curation/curate",
        json={
            "target_count": -5,
            "iterations": 1,
            "album": new_album["key"],
            "method": "fps",
            "excluded_indices": []
        }
    )
    # Expect 400 or 500 for validation errors
    assert response.status_code in [400, 500]


def test_curate_async_iterations_capped(client, new_album, monkeypatch):
    """Test that iterations are capped at the maximum."""
    build_index(client, new_album, monkeypatch)
    
    # Request more than max iterations (30)
    response = client.post(
        "/api/curation/curate",
        json={
            "target_count": 2,
            "iterations": 100,
            "album": new_album["key"],
            "method": "fps",
            "excluded_indices": []
        }
    )
    assert response.status_code == 200
    data = response.json()
    # Should be capped at 30
    assert data["iterations"] == 30


def test_progress_nonexistent_job(client):
    """Test progress endpoint with nonexistent job ID."""
    response = client.get("/api/curation/curate/progress/nonexistent_job_id")
    assert response.status_code == 404


def test_export_endpoint(client, new_album, monkeypatch, tmp_path):
    """Test the export endpoint."""
    build_index(client, new_album, monkeypatch)
    
    # First get some files from curation
    response = client.post(
        "/api/curation/curate_sync",
        json={
            "target_count": 2,
            "iterations": 1,
            "album": new_album["key"],
            "method": "fps",
            "excluded_indices": []
        }
    )
    assert response.status_code == 200
    data = response.json()
    selected_files = data["selected_files"]
    
    # Create export folder within home directory (as required by endpoint)
    import tempfile
    with tempfile.TemporaryDirectory(dir=Path.home()) as temp_dir:
        export_folder = Path(temp_dir) / "exported_images"
        
        # Export the files
        response = client.post(
            "/api/curation/export",
            json={
                "filenames": selected_files,
                "output_folder": str(export_folder)
            }
        )
        assert response.status_code == 200
        result = response.json()
        assert result["status"] == "success"
        assert "exported" in result
        assert result["exported"] > 0
        
        # Verify files were actually exported
        assert export_folder.exists()
        exported_files = list(export_folder.iterdir())
        assert len(exported_files) > 0


def test_export_validation(client, tmp_path):
    """Test validation of export parameters."""
    # Test empty output folder
    response = client.post(
        "/api/curation/export",
        json={
            "filenames": ["some_file.jpg"],
            "output_folder": ""
        }
    )
    assert response.status_code == 400
    
    # Test invalid output folder path
    response = client.post(
        "/api/curation/export",
        json={
            "filenames": ["some_file.jpg"],
            "output_folder": "/\x00invalid"
        }
    )
    assert response.status_code == 400


def test_export_path_traversal_protection(client):
    """Test that export prevents path traversal attacks."""
    # Try to export to system directory outside user home
    response = client.post(
        "/api/curation/export",
        json={
            "filenames": ["some_file.jpg"],
            "output_folder": "/etc"
        }
    )
    assert response.status_code == 400


def test_export_nonexistent_files(client):
    """Test export with nonexistent files."""
    import tempfile
    with tempfile.TemporaryDirectory(dir=Path.home()) as temp_dir:
        export_folder = Path(temp_dir) / "export_test"
        
        response = client.post(
            "/api/curation/export",
            json={
                "filenames": ["/nonexistent/file1.jpg", "/nonexistent/file2.jpg"],
                "output_folder": str(export_folder)
            }
        )
        assert response.status_code == 200
        result = response.json()
        # Should succeed but with 0 exported
        assert result["exported"] == 0


def test_curate_multiple_iterations(client, new_album, monkeypatch):
    """Test curation with multiple iterations for consensus."""
    build_index(client, new_album, monkeypatch)
    
    response = client.post(
        "/api/curation/curate_sync",
        json={
            "target_count": 2,
            "iterations": 5,
            "album": new_album["key"],
            "method": "fps",
            "excluded_indices": []
        }
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    
    # Check analysis_results contain frequency information
    analysis_results = data["analysis_results"]
    assert len(analysis_results) > 0
    for result in analysis_results:
        assert "frequency" in result
        assert "count" in result
        assert "filename" in result
        assert "subfolder" in result
        assert "filepath" in result
        assert "index" in result
        # Frequency should be between 0 and 100
        assert 0 <= result["frequency"] <= 100


def test_curate_analysis_results_format(client, new_album, monkeypatch):
    """Test that analysis results have the correct format."""
    build_index(client, new_album, monkeypatch)
    
    response = client.post(
        "/api/curation/curate_sync",
        json={
            "target_count": 2,
            "iterations": 3,
            "album": new_album["key"],
            "method": "fps",
            "excluded_indices": []
        }
    )
    assert response.status_code == 200
    data = response.json()
    
    # Verify analysis_results structure
    analysis_results = data["analysis_results"]
    for result in analysis_results:
        # Each result should have all required fields
        required_fields = ["filename", "subfolder", "filepath", "index", "count", "frequency"]
        for field in required_fields:
            assert field in result, f"Missing field: {field}"
        
        # Verify data types
        assert isinstance(result["filename"], str)
        assert isinstance(result["subfolder"], str)
        assert isinstance(result["filepath"], str)
        assert isinstance(result["index"], int)
        assert isinstance(result["count"], int)
        assert isinstance(result["frequency"], (int, float))
