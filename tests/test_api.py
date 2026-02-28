"""Tests for the Party Games API."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app import GAME_DATA, GTY_SONGS, SESSION_STORE, app

BASE = "http://test"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as ac:
        yield ac


@pytest.fixture(autouse=True)
def _clear_sessions():
    """Clear session store between tests."""
    SESSION_STORE.clear()
    yield
    SESSION_STORE.clear()


async def _start_session(
    client: AsyncClient,
    categories: list[str] | None = None,
    game: str = "hints",
):
    """POST /start with given categories and return cookies."""
    if categories is None:
        categories = ["objecten"]
    data = {"categories": categories, "game": game}
    resp = await client.post("/start", data=data, follow_redirects=False)
    assert resp.status_code == 303
    return resp.cookies


def _disable_rate_limit(sid: str):
    """Give a session unlimited rate tokens for testing."""
    if sid in SESSION_STORE:
        SESSION_STORE[sid]["rate_tokens"] = 999999


def _get_sid_from_store() -> str | None:
    """Return the first (and usually only) session id in the store."""
    for sid in SESSION_STORE:
        return sid
    return None


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_healthz(client: AsyncClient):
    resp = await client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@pytest.mark.anyio
async def test_home_page(client: AsyncClient):
    resp = await client.get("/")
    assert resp.status_code == 200
    assert "Party Games" in resp.text
    assert "Hints" in resp.text
    assert "Pictionary" in resp.text
    assert "Raad het Jaar" in resp.text


@pytest.mark.anyio
async def test_hints_index(client: AsyncClient):
    resp = await client.get("/hints")
    assert resp.status_code == 200
    assert "Hints" in resp.text


@pytest.mark.anyio
async def test_pictionary_index(client: AsyncClient):
    resp = await client.get("/pictionary")
    assert resp.status_code == 200
    assert "Pictionary" in resp.text


@pytest.mark.anyio
async def test_invalid_game_redirect(client: AsyncClient):
    resp = await client.get("/nonexistent", follow_redirects=False)
    assert resp.status_code == 303
    assert resp.headers["location"] == "/"


@pytest.mark.anyio
async def test_categories_endpoint(client: AsyncClient):
    # Default game is hints
    resp = await client.get("/categories")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    names = {c["name"] for c in data}
    for cat in GAME_DATA["hints"]:
        assert cat in names
    for entry in data:
        assert entry["count"] == len(GAME_DATA["hints"][entry["name"]])


@pytest.mark.anyio
async def test_start_no_selection(client: AsyncClient):
    resp = await client.post(
        "/start", data={"game": "hints"}, follow_redirects=False
    )
    assert resp.status_code == 303
    assert "error=no_selection" in resp.headers["location"]


@pytest.mark.anyio
async def test_next_no_repeat_hints():
    """Words should not repeat within a session until pool is exhausted."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        cookies = await _start_session(client, ["uitdrukkingen"], "hints")
        client.cookies.update(cookies)

        sid = _get_sid_from_store()
        _disable_rate_limit(sid)

        seen: set[str] = set()
        count = len(GAME_DATA["hints"]["uitdrukkingen"])

        for _ in range(count):
            resp = await client.post("/next")
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            word = resp.json()["word"]
            assert word not in seen, f"Duplicate word: {word}"
            seen.add(word)

        # Next request should be 204 (empty pool)
        resp = await client.post("/next")
        assert resp.status_code == 204
        assert resp.headers.get("x-empty-pool") == "true"


@pytest.mark.anyio
async def test_pictionary_next_has_category():
    """Pictionary /next should return category and category_color."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        cookies = await _start_session(client, ["voorwerp"], "pictionary")
        client.cookies.update(cookies)

        resp = await client.post("/next")
        assert resp.status_code == 200
        data = resp.json()
        assert "word" in data
        assert "category" in data
        assert "category_color" in data


@pytest.mark.anyio
async def test_alle_selection():
    """Selecting 'alle' should provide words from all categories."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        cookies = await _start_session(client, ["alle"], "hints")
        client.cookies.update(cookies)

        resp = await client.post("/next")
        assert resp.status_code == 200
        assert "word" in resp.json()


@pytest.mark.anyio
async def test_reset_used():
    """After reset, words should be available again."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        cookies = await _start_session(client, ["uitdrukkingen"], "hints")
        client.cookies.update(cookies)

        sid = _get_sid_from_store()
        _disable_rate_limit(sid)

        count = len(GAME_DATA["hints"]["uitdrukkingen"])
        for _ in range(count):
            resp = await client.post("/next")
            assert resp.status_code == 200

        # Pool empty
        resp = await client.post("/next")
        assert resp.status_code == 204

        # Reset
        resp = await client.post("/reset_used")
        assert resp.status_code == 200

        # Should get words again
        resp = await client.post("/next")
        assert resp.status_code == 200
        assert "word" in resp.json()


@pytest.mark.anyio
async def test_sessions_independent():
    """Two separate clients should have independent word pools."""
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url=BASE) as client1:
        cookies1 = await _start_session(client1, ["uitdrukkingen"], "hints")
        client1.cookies.update(cookies1)

        sid1 = _get_sid_from_store()
        _disable_rate_limit(sid1)

        words1 = set()
        for _ in range(5):
            resp = await client1.post("/next")
            words1.add(resp.json()["word"])

    async with AsyncClient(transport=transport, base_url=BASE) as client2:
        cookies2 = await _start_session(client2, ["uitdrukkingen"], "hints")
        client2.cookies.update(cookies2)

        resp = await client2.post("/next")
        assert resp.status_code == 200
        assert "word" in resp.json()


@pytest.mark.anyio
async def test_play_page():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        cookies = await _start_session(client, ["objecten"], "hints")
        client.cookies.update(cookies)
        resp = await client.get("/play")
        assert resp.status_code == 200
        assert "Volgend woord" in resp.text


# ---------------------------------------------------------------------------
# GTY (Guess the Year) tests
# ---------------------------------------------------------------------------

def _first_gty_origin() -> str:
    """Return the first origin that has songs."""
    for origin in GTY_SONGS:
        if GTY_SONGS[origin]:
            return origin
    pytest.skip("No GTY origins with songs")


async def _start_gty_session(
    client: AsyncClient,
    origins: list[str] | None = None,
    num_teams: int = 2,
    rounds_to_win: int = 3,
    difficulty: str = "normaal",
) -> None:
    """Select origins, set up teams, return ready-to-play client."""
    if origins is None:
        origins = [_first_gty_origin()]
    # POST /start with guess-the-year
    data = {"categories": origins, "game": "guess-the-year"}
    resp = await client.post("/start", data=data, follow_redirects=False)
    assert resp.status_code == 303
    client.cookies.update(resp.cookies)

    # POST /gty/start with team setup
    form = {
        "num_teams": str(num_teams),
        "rounds_to_win": str(rounds_to_win),
        "difficulty": difficulty,
    }
    for i in range(num_teams):
        form[f"team_{i}"] = f"Team {i + 1}"
    resp = await client.post("/gty/start", data=form, follow_redirects=False)
    assert resp.status_code == 303
    client.cookies.update(resp.cookies)


@pytest.mark.anyio
async def test_gty_index():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        resp = await client.get("/guess-the-year")
        assert resp.status_code == 200
        assert "Raad het Jaar" in resp.text


@pytest.mark.anyio
async def test_gty_start_no_selection():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        resp = await client.post(
            "/start", data={"game": "guess-the-year"}, follow_redirects=False
        )
        assert resp.status_code == 303
        assert "error=no_selection" in resp.headers["location"]


@pytest.mark.anyio
async def test_gty_setup_page():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        origin = _first_gty_origin()
        data = {"categories": [origin], "game": "guess-the-year"}
        resp = await client.post("/start", data=data, follow_redirects=False)
        client.cookies.update(resp.cookies)

        resp = await client.get("/gty/setup")
        assert resp.status_code == 200
        assert "Teams instellen" in resp.text


@pytest.mark.anyio
async def test_gty_next_returns_song():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client)

        resp = await client.post("/gty/next")
        assert resp.status_code == 200
        data = resp.json()
        assert "round" in data
        assert "youtube_link" in data
        # Should NOT contain the answer
        assert "artist" not in data
        assert "title" not in data
        assert "year" not in data


@pytest.mark.anyio
async def test_gty_reveal_returns_answer():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client)

        await client.post("/gty/next")
        resp = await client.post("/gty/reveal")
        assert resp.status_code == 200
        data = resp.json()
        assert "artist" in data
        assert "title" in data
        assert "year" in data
        assert isinstance(data["year"], int)


@pytest.mark.anyio
async def test_gty_award_and_scoreboard():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client, num_teams=2, rounds_to_win=3)

        await client.post("/gty/next")
        await client.post("/gty/reveal")

        resp = await client.post("/gty/award", data={"team": "0"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["scores"][0] == 1
        assert data["scores"][1] == 0
        assert data["winner"] is None


@pytest.mark.anyio
async def test_gty_award_before_reveal():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client)

        await client.post("/gty/next")
        # Try to award without revealing
        resp = await client.post("/gty/award", data={"team": "0"})
        assert resp.status_code == 400


@pytest.mark.anyio
async def test_gty_winner_detection():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client, num_teams=2, rounds_to_win=2)
        sid = _get_sid_from_store()
        _disable_rate_limit(sid)

        # Win 2 rounds for team 0
        for _ in range(2):
            resp = await client.post("/gty/next")
            assert resp.status_code == 200
            await client.post("/gty/reveal")
            resp = await client.post("/gty/award", data={"team": "0"})

        data = resp.json()
        assert data["winner"] == "Team 1"


@pytest.mark.anyio
async def test_gty_undo():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client, num_teams=2, rounds_to_win=3)

        await client.post("/gty/next")
        await client.post("/gty/reveal")
        await client.post("/gty/award", data={"team": "0"})

        resp = await client.post("/gty/undo")
        assert resp.status_code == 200
        data = resp.json()
        assert data["scores"][0] == 0


@pytest.mark.anyio
async def test_gty_state():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client, num_teams=2, rounds_to_win=5)

        resp = await client.get("/gty/state")
        assert resp.status_code == 200
        data = resp.json()
        assert data["num_teams"] == 2
        assert data["rounds_to_win"] == 5
        assert data["scores"] == [0, 0]
        assert data["team_names"] == ["Team 1", "Team 2"]


@pytest.mark.anyio
async def test_gty_no_repeat_songs():
    """Songs should not repeat within a session."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        origin = _first_gty_origin()
        await _start_gty_session(client, origins=[origin], rounds_to_win=999)
        sid = _get_sid_from_store()
        _disable_rate_limit(sid)

        seen: set[str] = set()
        # Request up to 20 songs (or all if fewer)
        count = min(20, len(GTY_SONGS[origin]))
        for _ in range(count):
            resp = await client.post("/gty/next")
            if resp.status_code == 204:
                break
            assert resp.status_code == 200
            await client.post("/gty/reveal")
            state_resp = await client.get("/gty/state")
            state = state_resp.json()
            key = f"{state.get('artist', '')}|{state.get('title', '')}"
            assert key not in seen, f"Duplicate song: {key}"
            seen.add(key)


@pytest.mark.anyio
async def test_gty_award_adds_year_to_timeline():
    """Award should add the song's year to team_years sorted."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client, num_teams=2, rounds_to_win=5)
        sid = _get_sid_from_store()
        _disable_rate_limit(sid)

        # Play two rounds, award both to team 0
        years = []
        for _ in range(2):
            await client.post("/gty/next")
            reveal_resp = await client.post("/gty/reveal")
            year = reveal_resp.json()["year"]
            years.append(year)
            resp = await client.post("/gty/award", data={"team": "0"})
            assert resp.status_code == 200

        data = resp.json()
        assert "team_years" in data
        assert data["team_years"][0] == sorted(years)
        assert data["team_years"][1] == []


@pytest.mark.anyio
async def test_gty_undo_removes_year_from_timeline():
    """Undo should remove the year from team_years."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client, num_teams=2, rounds_to_win=5)

        await client.post("/gty/next")
        await client.post("/gty/reveal")
        award_resp = await client.post("/gty/award", data={"team": "0"})
        year = award_resp.json()["team_years"][0][0]

        resp = await client.post("/gty/undo")
        assert resp.status_code == 200
        data = resp.json()
        assert year not in data["team_years"][0]


@pytest.mark.anyio
async def test_gty_jeton_add():
    """Adding a jeton should increase the count."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client, num_teams=2, rounds_to_win=5)

        resp = await client.post("/gty/jeton", data={"team": "0", "action": "add"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["jetons"][0] == 1
        assert data["jetons"][1] == 0

        # Add another
        resp = await client.post("/gty/jeton", data={"team": "0", "action": "add"})
        assert resp.json()["jetons"][0] == 2


@pytest.mark.anyio
async def test_gty_jeton_use():
    """Using a jeton should decrease the count."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client, num_teams=2, rounds_to_win=5)

        # Add one first
        await client.post("/gty/jeton", data={"team": "1", "action": "add"})
        resp = await client.post("/gty/jeton", data={"team": "1", "action": "use"})
        assert resp.status_code == 200
        assert resp.json()["jetons"][1] == 0


@pytest.mark.anyio
async def test_gty_jeton_use_zero_fails():
    """Using a jeton when count is 0 should fail."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client, num_teams=2, rounds_to_win=5)

        resp = await client.post("/gty/jeton", data={"team": "0", "action": "use"})
        assert resp.status_code == 400


@pytest.mark.anyio
async def test_gty_state_includes_years_and_jetons():
    """State should include team_years and jetons."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client, num_teams=2, rounds_to_win=5)

        resp = await client.get("/gty/state")
        assert resp.status_code == 200
        data = resp.json()
        assert "team_years" in data
        assert "jetons" in data
        assert data["team_years"] == [[], []]
        assert data["jetons"] == [0, 0]


@pytest.mark.anyio
async def test_gty_difficulty_in_state():
    """State should include the difficulty setting."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client, difficulty="moeilijk")
        resp = await client.get("/gty/state")
        assert resp.status_code == 200
        assert resp.json()["difficulty"] == "moeilijk"


@pytest.mark.anyio
async def test_gty_difficulty_makkelijk_returns_songs():
    """Easy difficulty should still return songs."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client, difficulty="makkelijk")
        resp = await client.post("/gty/next")
        assert resp.status_code == 200
        assert "round" in resp.json()


@pytest.mark.anyio
async def test_gty_difficulty_moeilijk_returns_songs():
    """Hard difficulty should still return songs."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        await _start_gty_session(client, difficulty="moeilijk")
        resp = await client.post("/gty/next")
        assert resp.status_code == 200
        assert "round" in resp.json()


@pytest.mark.anyio
async def test_gty_custom_rounds_to_win():
    """Custom rounds_to_win field should override radio selection."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as client:
        origin = _first_gty_origin()
        data = {"categories": [origin], "game": "guess-the-year"}
        resp = await client.post("/start", data=data, follow_redirects=False)
        client.cookies.update(resp.cookies)

        form = {
            "num_teams": "2",
            "rounds_to_win": "5",
            "rounds_to_win_custom": "12",
            "difficulty": "normaal",
            "team_0": "A",
            "team_1": "B",
        }
        resp = await client.post("/gty/start", data=form, follow_redirects=False)
        client.cookies.update(resp.cookies)

        state = await client.get("/gty/state")
        assert state.json()["rounds_to_win"] == 12
