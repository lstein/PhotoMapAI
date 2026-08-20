"""Tests for the raw HTTP behaviour of ``photomap.backend.invokeai_client``.

The board-index tests (``test_invokeai_board_index.py``) monkeypatch
``fetch_board_image_relpaths`` / ``fetch_board_video_relpaths`` wholesale,
so the request-building details are covered here instead — most importantly
that board fetches ask InvokeAI to exclude canvas intermediates and
mask/control assets (mirroring what the InvokeAI gallery itself displays),
and that each file's on-disk subfolder is read off its DTO rather than
assumed flat.
"""

from pathlib import Path

import pytest
from fastapi import HTTPException

from photomap.backend import invokeai_client


class _Resp:
    def __init__(self, status_code=200, json_body=None, text=""):
        self.status_code = status_code
        self._json = json_body if json_body is not None else []
        self.text = text

    def json(self):
        return self._json


class _RecordingClient:
    """httpx.AsyncClient stub that records each GET and returns scripted responses."""

    def __init__(self, script):
        self._script = list(script)
        self.calls: list[dict] = []

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, **kwargs):
        self.calls.append({"url": url, "params": kwargs.get("params")})
        return self._script.pop(0)

    async def delete(self, url, **kwargs):
        self.calls.append({"url": url, "method": "DELETE"})
        return self._script.pop(0)


@pytest.fixture(autouse=True)
def _clear_token_cache():
    invokeai_client._invalidate_token_cache()
    yield
    invokeai_client._invalidate_token_cache()


_UNSET = object()


def _page(
    items, name_key="image_name", subfolder_key="image_subfolder", total=_UNSET
):
    """One page of a listing endpoint, in the DTO shape InvokeAI returns.

    ``total`` is the count of *all* rows matching the query, not the page's
    own length; it defaults to the page length so single-page tests read as
    a complete listing.  Pass ``None`` for a server that omits it.
    """
    body = {
        "items": [
            {name_key: name, subfolder_key: subfolder} for name, subfolder in items
        ],
        "offset": 0,
        "limit": invokeai_client._DTO_PAGE_SIZE,
    }
    resolved = len(items) if total is _UNSET else total
    if resolved is not None:
        body["total"] = resolved
    return _Resp(json_body=body)


@pytest.mark.asyncio
async def test_fetch_board_image_relpaths_filters_out_intermediates(monkeypatch):
    """Board fetches must request only non-intermediate general/user images."""
    stub = _RecordingClient(
        [
            _page([("aaa.png", ""), ("bbb.png", "")]),
            _page([("bbb.png", ""), ("ccc.png", "")]),
        ]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    relpaths = await invokeai_client.fetch_board_image_relpaths(
        "http://localhost:9090", ["board-1", "none"], None, None
    )

    assert relpaths == ["aaa.png", "bbb.png", "ccc.png"]
    assert [call["url"] for call in stub.calls] == [
        "http://localhost:9090/api/v1/images/",
        "http://localhost:9090/api/v1/images/",
    ]
    assert [call["params"]["board_id"] for call in stub.calls] == ["board-1", "none"]
    for call in stub.calls:
        assert call["params"]["is_intermediate"] == "false"
        assert call["params"]["categories"] == ["general", "user"]


@pytest.mark.asyncio
async def test_fetch_board_relpaths_prefix_the_reported_subfolder(monkeypatch):
    """InvokeAI files media into a subfolder chosen by a server-side strategy
    and records it per row.  Ignoring it (the old flat assumption) means every
    file on a ``type``-organized backend resolves to a path that is not there,
    which is exactly how a board full of videos indexes as empty."""
    stub = _RecordingClient(
        [
            _page([("aaa.png", "general"), ("bbb.png", "2026/08/19"), ("ccc.png", "")]),
        ]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    relpaths = await invokeai_client.fetch_board_image_relpaths(
        "http://localhost:9090", ["board-1"], None, None
    )

    assert relpaths == ["general/aaa.png", "2026/08/19/bbb.png", "ccc.png"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name, subfolder",
    [
        ("escape.png", "../../../etc"),
        ("absolute.png", "/etc"),
        ("../traversal.png", "general"),
        # Backslash spellings.  These are the dangerous ones: none of them
        # look absolute as written, but rewriting the separators — which an
        # earlier version of this code did, to "support" a Windows-hosted
        # InvokeAI — turns them into absolute paths, and joining an absolute
        # path throws the outputs directory away entirely.  InvokeAI refuses
        # to store a backslash in a subfolder at all, so no real server
        # reports one.
        ("bs.png", "\\etc"),
        ("bs-unc.png", "\\\\server\\share"),
        ("bs-root.png", "\\"),
        ("..\\..\\win.png", "general"),
        # Empty and dot segments, rejected by InvokeAI's own validator too.
        ("dot.png", "."),
        ("empty-seg.png", "a//b"),
        ("blank.png", " /../.."),
    ],
)
async def test_fetch_board_relpaths_reject_paths_that_escape_outputs(
    monkeypatch, name, subfolder
):
    """The subfolder is a server-supplied string that PhotoMap turns into a
    local filesystem path, so anything that is not a plain relative path is
    dropped rather than followed out of the outputs directory.

    Asserted through the joined path, not just the returned string: what
    matters is where ``outputs/images / relpath`` lands, and an absolute
    relpath silently discards the left-hand side of that join."""
    stub = _RecordingClient([_page([("ok.png", "general"), (name, subfolder)])])
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    relpaths = await invokeai_client.fetch_board_image_relpaths(
        "http://localhost:9090", ["board-1"], None, None
    )

    assert relpaths == ["general/ok.png"]
    outputs = Path("/invokeai/outputs/images")
    for rel in relpaths:
        assert (outputs / rel).is_relative_to(outputs)


@pytest.mark.asyncio
async def test_fetch_board_relpaths_keep_legitimate_nested_subfolders(monkeypatch):
    """The rejection rule must not swallow the layouts InvokeAI really
    produces — ``type`` yields one segment, ``date`` yields three."""
    stub = _RecordingClient(
        [_page([("a.png", "general"), ("b.png", "2026/08/19"), ("c.png", "ab")])]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    relpaths = await invokeai_client.fetch_board_image_relpaths(
        "http://localhost:9090", ["board-1"], None, None
    )

    assert relpaths == ["general/a.png", "2026/08/19/b.png", "ab/c.png"]


@pytest.mark.asyncio
async def test_fetch_board_relpaths_retry_a_listing_that_came_up_short(monkeypatch):
    """Offset pagination is not a snapshot: deleting one row between pages
    shifts every later row down an offset, so exactly one live row is skipped.
    The caller prunes indexed rows this list does not mention, so a short
    listing silently deletes a file that is still on the board — it has to be
    caught against the server's own ``total`` and re-read."""
    monkeypatch.setattr(invokeai_client, "_DTO_PAGE_SIZE", 2)
    stub = _RecordingClient(
        [
            # First walk: server says 4, a deletion mid-walk means we see 3.
            _page([("a.png", ""), ("b.png", "")], total=4),
            _page([("d.png", "")], total=4),
            # Re-read: quiet server, all 3 remaining rows, total agrees.
            _page([("a.png", ""), ("b.png", "")], total=3),
            _page([("d.png", "")], total=3),
        ]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    relpaths = await invokeai_client.fetch_board_image_relpaths(
        "http://localhost:9090", ["board-1"], None, None
    )

    assert relpaths == ["a.png", "b.png", "d.png"]
    assert len(stub.calls) == 4


@pytest.mark.asyncio
async def test_fetch_board_relpaths_fail_rather_than_prune_a_short_listing(monkeypatch):
    """A listing that stays short across two reads is not churn — it is a
    backend (or an intermediary) that will not serve what it says it holds.
    Failing leaves the previous index intact; returning the short list would
    delete an indexed row for every entry the server withheld."""
    monkeypatch.setattr(invokeai_client, "_DTO_PAGE_SIZE", 2)
    stub = _RecordingClient(
        [
            _page([("a.png", ""), ("b.png", "")], total=99),
            _page([("c.png", "")], total=99),
            _page([("a.png", ""), ("b.png", "")], total=99),
            _page([("c.png", "")], total=99),
        ]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    with pytest.raises(HTTPException) as excinfo:
        await invokeai_client.fetch_board_image_relpaths(
            "http://localhost:9090", ["board-1"], None, None
        )

    assert excinfo.value.status_code == 502
    assert "3 of 99" in excinfo.value.detail


@pytest.mark.asyncio
async def test_fetch_board_relpaths_stop_paging_a_server_that_ignores_offset(
    monkeypatch,
):
    """A caching or query-stripping proxy can re-serve page one forever.  The
    short-page rule alone never fires there, so the walk has to give up once
    it has paged past the total the server declared — and then report the
    listing as unusable rather than return the fragment it did get."""
    monkeypatch.setattr(invokeai_client, "_DTO_PAGE_SIZE", 2)
    same_page = [("a.png", ""), ("b.png", "")]
    stub = _RecordingClient([_page(same_page, total=10) for _ in range(50)])
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    with pytest.raises(HTTPException) as excinfo:
        await invokeai_client.fetch_board_image_relpaths(
            "http://localhost:9090", ["board-1"], None, None
        )

    assert excinfo.value.status_code == 502
    # 6 pages per walk (offset runs 0..10, then passes total + one page),
    # twice — bounded, and nowhere near the 1000-page budget.
    assert len(stub.calls) == 12


@pytest.mark.asyncio
async def test_fetch_board_relpaths_tolerate_a_listing_with_no_total(monkeypatch):
    """The completeness check is best-effort: a payload without a usable
    ``total`` must still index, not fail."""
    stub = _RecordingClient([_page([("a.png", "general")], total=None)])
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    relpaths = await invokeai_client.fetch_board_image_relpaths(
        "http://localhost:9090", ["board-1"], None, None
    )

    assert relpaths == ["general/a.png"]


@pytest.mark.asyncio
async def test_fetch_board_relpaths_tolerate_rows_added_mid_walk(monkeypatch):
    """Rows added while the walk is in flight push existing rows to a higher
    offset, so a page can repeat what an earlier one returned.  That is a
    duplicate, not a gap: it must dedupe, not trigger a re-read."""
    monkeypatch.setattr(invokeai_client, "_DTO_PAGE_SIZE", 2)
    stub = _RecordingClient(
        [
            _page([("b.png", ""), ("c.png", "")], total=3),
            # "a.png" was created mid-walk and sorts first, so page two
            # re-shows c.png before reaching d.png.
            _page([("c.png", ""), ("d.png", "")], total=4),
            _page([], total=4),
        ]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    relpaths = await invokeai_client.fetch_board_image_relpaths(
        "http://localhost:9090", ["board-1"], None, None
    )

    assert relpaths == ["b.png", "c.png", "d.png"]
    assert len(stub.calls) == 3


@pytest.mark.asyncio
async def test_fetch_board_relpaths_page_until_a_short_page(monkeypatch):
    """The listing endpoint is paginated and clamped server-side, so a board
    bigger than one page must be walked — stopping at the first page would
    silently index only the newest 1000 files."""
    monkeypatch.setattr(invokeai_client, "_DTO_PAGE_SIZE", 2)
    stub = _RecordingClient(
        [
            # ``total`` is the whole board, not the page — every page repeats
            # the same figure, which is what the real endpoint does.
            _page([("a.png", "general"), ("b.png", "general")], total=5),
            _page([("c.png", "general"), ("d.png", "general")], total=5),
            _page([("e.png", "general")], total=5),
        ]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    relpaths = await invokeai_client.fetch_board_image_relpaths(
        "http://localhost:9090", ["board-1"], None, None
    )

    assert relpaths == [f"general/{n}.png" for n in "abcde"]
    assert [call["params"]["offset"] for call in stub.calls] == [0, 2, 4]


@pytest.mark.asyncio
async def test_fetch_board_video_relpaths_queries_the_video_router(monkeypatch):
    """Videos are a separate resource with their own outputs directory, and
    get the same intermediate/category filtering as images (a Wan pipeline
    writes its intermediate clips to the board too)."""
    stub = _RecordingClient(
        [
            _page([("a.mp4", "general")], "video_name", "video_subfolder"),
            _page(
                [("a.mp4", "general"), ("c.mp4", "user")],
                "video_name",
                "video_subfolder",
            ),
        ]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    result = await invokeai_client.fetch_board_video_relpaths(
        "http://localhost:9090", ["board-1", "none"], None, None
    )

    assert result.relpaths == ["general/a.mp4", "user/c.mp4"]
    assert result.api_available is True
    assert [call["url"] for call in stub.calls] == [
        "http://localhost:9090/api/v1/videos/",
        "http://localhost:9090/api/v1/videos/",
    ]
    assert [call["params"]["board_id"] for call in stub.calls] == ["board-1", "none"]
    for call in stub.calls:
        assert call["params"]["is_intermediate"] == "false"
        assert call["params"]["categories"] == ["general", "user"]


@pytest.mark.asyncio
async def test_fetch_board_video_relpaths_tolerates_backend_without_videos(monkeypatch):
    """An InvokeAI predating the video API 404s the whole router; that must
    not fail the index run, and it must be distinguishable from a board that
    genuinely holds no videos — the caller prunes rows for anything absent
    from the listing."""
    stub = _RecordingClient([_Resp(status_code=404, text="Not Found")])
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    result = await invokeai_client.fetch_board_video_relpaths(
        "http://localhost:9090", ["board-1"], None, None
    )

    assert result.relpaths == []
    assert result.api_available is False


@pytest.mark.asyncio
async def test_fetch_board_image_relpaths_raise_on_a_404(monkeypatch):
    """There is no InvokeAI old enough to lack an image listing, so unlike
    videos a 404 here is a real failure and must not be swallowed into an
    empty — and therefore index-pruning — result."""
    stub = _RecordingClient([_Resp(status_code=404, text="Not Found")])
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    with pytest.raises(HTTPException) as excinfo:
        await invokeai_client.fetch_board_image_relpaths(
            "http://localhost:9090", ["board-1"], None, None
        )
    assert excinfo.value.status_code == 502


@pytest.mark.asyncio
async def test_fetch_board_video_relpaths_keeps_paths_from_earlier_boards(monkeypatch):
    """A 404 on a later board must not discard what earlier boards returned.
    InvokeAI answers 404 for a board a non-admin cannot read, not only for a
    missing video router, so the successful listings are still good data."""
    stub = _RecordingClient(
        [
            _page([("a.mp4", "general")], "video_name", "video_subfolder"),
            _Resp(status_code=404, text="Board not found"),
        ]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    result = await invokeai_client.fetch_board_video_relpaths(
        "http://localhost:9090", ["board-1", "board-gone"], None, None
    )

    assert result.relpaths == ["general/a.mp4"]
    assert result.api_available is False


@pytest.mark.asyncio
async def test_fetch_board_video_relpaths_rejects_unexpected_shape(monkeypatch):
    """A bare list (the shape the retired ``/names`` endpoints returned) is not
    silently accepted — reading no items off a successful response would
    quietly drop every video from the album."""
    stub = _RecordingClient([_Resp(json_body=["a.mp4"])])
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    with pytest.raises(HTTPException) as excinfo:
        await invokeai_client.fetch_board_video_relpaths(
            "http://localhost:9090", ["board-1"], None, None
        )
    assert excinfo.value.status_code == 502


@pytest.mark.asyncio
async def test_delete_video_uses_the_video_endpoint(monkeypatch):
    stub = _RecordingClient(
        [_Resp(json_body={"deleted_videos": ["a.mp4"], "failed_videos": []})]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    await invokeai_client.delete_video(
        "http://localhost:9090", "a.mp4", None, None
    )

    assert stub.calls == [
        {"url": "http://localhost:9090/api/v1/videos/i/a.mp4", "method": "DELETE"}
    ]


@pytest.mark.asyncio
async def test_delete_video_raises_when_reported_as_failed(monkeypatch):
    """InvokeAI can report a failure *inside* a 200 response. Treating that as
    success would drop the local index row while the video stayed on the
    board, so it has to surface as an error."""
    stub = _RecordingClient(
        [_Resp(json_body={"deleted_videos": [], "failed_videos": ["a.mp4"]})]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    with pytest.raises(HTTPException) as excinfo:
        await invokeai_client.delete_video(
            "http://localhost:9090", "a.mp4", None, None
        )
    assert excinfo.value.status_code == 502


@pytest.mark.asyncio
async def test_delete_video_tolerates_already_gone(monkeypatch):
    """A 404 means InvokeAI has forgotten the video; the caller still needs to
    drop its index row, so this returns rather than raising."""
    stub = _RecordingClient([_Resp(status_code=404, text="Video not found")])
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    await invokeai_client.delete_video(
        "http://localhost:9090", "a.mp4", None, None
    )


@pytest.mark.asyncio
async def test_delete_video_accepts_a_200_that_is_not_an_object(monkeypatch):
    """The success check reads ``failed_videos`` off the body, so a 200
    carrying anything but a JSON object must not blow up: InvokeAI has
    already deleted the video at that point, and an exception here would keep
    the index row pointing at a file that is gone."""
    stub = _RecordingClient([_Resp(json_body=["a.mp4"])])
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    await invokeai_client.delete_video("http://localhost:9090", "a.mp4", None, None)
