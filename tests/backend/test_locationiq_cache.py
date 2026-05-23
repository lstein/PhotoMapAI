"""Tests for the LocationIQ reverse-geocode cache in
:mod:`photomap.backend.metadata_modules.exif_formatter`.

The cache funnels reverse-geocode lookups through a bounded LRU keyed by
``(round(lat, 4), round(lon, 4), api_key)`` so that:

  * adjacent photos at the same place share one network round-trip,
  * failures (bad key / rate-limited) don't get retried per-image,
  * changing the API key naturally bypasses old entries,
  * the cache size stays bounded on long-running servers.

These tests pin the internal fetcher with ``monkeypatch`` so no real
network traffic occurs and the cache contract is verified directly.
"""

from __future__ import annotations

import pytest

from photomap.backend.metadata_modules import exif_formatter


@pytest.fixture(autouse=True)
def _clear_cache():
    """Each test starts with an empty cache so order doesn't matter."""
    exif_formatter._locationiq_cache.clear()
    yield
    exif_formatter._locationiq_cache.clear()


def _stub_fetch(monkeypatch, response):
    """Replace the network fetcher with one that records its calls and
    returns ``response`` (or, if ``response`` is a list, the next element
    per invocation)."""
    calls: list[tuple] = []

    if isinstance(response, list):
        responses = iter(response)

        def _fake(lat, lon, key):
            calls.append((lat, lon, key))
            return next(responses)
    else:
        def _fake(lat, lon, key):
            calls.append((lat, lon, key))
            return response

    monkeypatch.setattr(
        exif_formatter, "_fetch_locationiq_place_name", _fake
    )
    return calls


# ---------------------------------------------------------------------------
# Cache hit / miss behavior
# ---------------------------------------------------------------------------


class TestCacheHitMiss:
    def test_first_call_misses_and_fetches(self, monkeypatch):
        calls = _stub_fetch(monkeypatch, ("Paris, France", "ok"))
        result = exif_formatter.get_locationiq_place_name(48.8566, 2.3522, "k")
        assert result == ("Paris, France", "ok")
        assert len(calls) == 1

    def test_repeat_call_hits_cache(self, monkeypatch):
        calls = _stub_fetch(monkeypatch, ("Paris, France", "ok"))
        exif_formatter.get_locationiq_place_name(48.8566, 2.3522, "k")
        exif_formatter.get_locationiq_place_name(48.8566, 2.3522, "k")
        exif_formatter.get_locationiq_place_name(48.8566, 2.3522, "k")
        assert len(calls) == 1

    def test_nearby_coords_within_rounding_share_cache(self, monkeypatch):
        # 4 decimal places ≈ 11 m. Both coord pairs below round to
        # (48.8566, 2.3522), so the second call should hit the cache.
        calls = _stub_fetch(monkeypatch, ("Paris, France", "ok"))
        exif_formatter.get_locationiq_place_name(48.85664, 2.35224, "k")
        exif_formatter.get_locationiq_place_name(48.85661, 2.35221, "k")
        assert len(calls) == 1

    def test_distant_coords_miss_separately(self, monkeypatch):
        calls = _stub_fetch(
            monkeypatch,
            [("Paris, France", "ok"), ("Tokyo, Japan", "ok")],
        )
        a = exif_formatter.get_locationiq_place_name(48.8566, 2.3522, "k")
        b = exif_formatter.get_locationiq_place_name(35.6762, 139.6503, "k")
        assert a == ("Paris, France", "ok")
        assert b == ("Tokyo, Japan", "ok")
        assert len(calls) == 2

    def test_distinct_api_keys_get_distinct_entries(self, monkeypatch):
        calls = _stub_fetch(
            monkeypatch,
            [("Paris, France", "ok"), (None, "unauthorized")],
        )
        good = exif_formatter.get_locationiq_place_name(48.8566, 2.3522, "good-key")
        bad = exif_formatter.get_locationiq_place_name(48.8566, 2.3522, "bad-key")
        # Different keys hit the fetcher twice — the cache key tuple differs.
        assert good == ("Paris, France", "ok")
        assert bad == (None, "unauthorized")
        assert len(calls) == 2


# ---------------------------------------------------------------------------
# Failures also caching — avoids hammering API while batch-rendering
# ---------------------------------------------------------------------------


class TestFailureCaching:
    @pytest.mark.parametrize(
        "failure",
        [
            (None, "unauthorized"),
            (None, "access forbidden"),
            (None, "rate limit exceeded"),
            (None, "timeout while fetching"),
            (None, "Error 502"),
        ],
    )
    def test_failure_results_are_cached(self, monkeypatch, failure):
        calls = _stub_fetch(monkeypatch, failure)
        exif_formatter.get_locationiq_place_name(48.8566, 2.3522, "k")
        exif_formatter.get_locationiq_place_name(48.8566, 2.3522, "k")
        # One fetch, two reads — the failure was cached.
        assert len(calls) == 1


# ---------------------------------------------------------------------------
# LRU eviction at capacity
# ---------------------------------------------------------------------------


class TestLRUEviction:
    def test_oldest_entries_evicted_past_max(self, monkeypatch):
        # Shrink the cap so the test is fast and the eviction is obvious.
        monkeypatch.setattr(exif_formatter, "_LOCATIONIQ_CACHE_MAX", 3)

        calls = _stub_fetch(
            monkeypatch,
            [
                ("A", "ok"),
                ("B", "ok"),
                ("C", "ok"),
                ("D", "ok"),
                ("A", "ok"),  # second fetch for A after eviction
            ],
        )

        # Fill the cache and overflow it.
        exif_formatter.get_locationiq_place_name(1.0, 1.0, "k")
        exif_formatter.get_locationiq_place_name(2.0, 2.0, "k")
        exif_formatter.get_locationiq_place_name(3.0, 3.0, "k")
        exif_formatter.get_locationiq_place_name(4.0, 4.0, "k")  # evicts (1.0, 1.0)

        # The first coord no longer in cache → another fetch.
        result = exif_formatter.get_locationiq_place_name(1.0, 1.0, "k")
        assert result == ("A", "ok")
        # 4 fills + 1 re-fetch for the evicted entry = 5 fetch calls total.
        assert len(calls) == 5

    def test_lru_move_to_end_on_hit(self, monkeypatch):
        # When entry A is HIT (not just stored), it must move to the most-
        # recent end so it survives a subsequent eviction caused by B's
        # newer insertion. (Without ``move_to_end`` on read this fails.)
        monkeypatch.setattr(exif_formatter, "_LOCATIONIQ_CACHE_MAX", 2)
        calls = _stub_fetch(
            monkeypatch,
            [("A", "ok"), ("B", "ok"), ("C", "ok"), ("B", "ok")],
        )

        exif_formatter.get_locationiq_place_name(1.0, 1.0, "k")  # A
        exif_formatter.get_locationiq_place_name(2.0, 2.0, "k")  # B
        exif_formatter.get_locationiq_place_name(1.0, 1.0, "k")  # A hit → bumped
        exif_formatter.get_locationiq_place_name(3.0, 3.0, "k")  # C, evicts B

        # A is still cached; B was evicted (bumped down by the hit).
        assert (1.0, 1.0, "k") in exif_formatter._locationiq_cache
        assert (2.0, 2.0, "k") not in exif_formatter._locationiq_cache
        # B will re-fetch on next access.
        exif_formatter.get_locationiq_place_name(2.0, 2.0, "k")
        assert len(calls) == 4


# ---------------------------------------------------------------------------
# Coordinate rounding precision
# ---------------------------------------------------------------------------


class TestCoordinateRounding:
    def test_rounds_to_four_decimal_places(self):
        key = exif_formatter._locationiq_cache_key(48.856612, 2.352234, "k")
        assert key == (48.8566, 2.3522, "k")

    def test_round_half_to_even_is_deterministic(self):
        # ``round`` uses banker's rounding; either direction is fine as
        # long as repeated calls with the same input land in the same
        # bucket. (Just verify stability.)
        a = exif_formatter._locationiq_cache_key(1.23455, 2.34565, "k")
        b = exif_formatter._locationiq_cache_key(1.23455, 2.34565, "k")
        assert a == b
