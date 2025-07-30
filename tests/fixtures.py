'''
Fixtures for pytest
'''

import os
import pytest

from fastapi.testclient import TestClient

@pytest.fixture
def client():
    """Fixture to create a test client for the Clipslide application."""
    from clipslide.backend.clipslide_server import app
    return TestClient(app)
