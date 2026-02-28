"""Party Games – Hints, Pictionary & Guess the Year built with FastAPI."""

from __future__ import annotations

import asyncio
import csv as csv_mod
import json
import hashlib
import os
import random
import re
import time
import unicodedata
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from itsdangerous import URLSafeSerializer

from settings import (
    APP_NAME,
    BLUF_DATA_PATH,
    CATEGORIES_DATA_PATH,
    DIT_OF_DAT_DATA_PATH,
    EMOJI_QUIZ_DATA_PATH,
    GTY_DATA_PATH,
    GTY_QR_DIR,
    HINTS_DATA_PATH,
    PICTIONARY_DATA_PATH,
    RANKING_DATA_PATH,
    RATE_LIMIT_PER_MIN,
    SCHATTINGEN_DATA_PATH,
    SESSION_SECRET,
    SESSION_TTL_SECONDS,
    TABOE_DATA_PATH,
    THIRTY_SECONDS_DATA_PATH,
    TIMELINE_DATA_PATH,
    WIE_BEN_IK_DATA_PATH,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize(word: str) -> str:
    """Lowercase, strip diacritics and non-alphanumeric chars for dedup."""
    word = word.strip().lower()
    nfkd = unicodedata.normalize("NFKD", word)
    return "".join(ch for ch in nfkd if not unicodedata.combining(ch))


def _load_thirty_seconds_words(path: str) -> list[str]:
    """Load the 30 seconds word list JSON."""
    if not os.path.isfile(path):
        raise FileNotFoundError(
            f"30 Seconds woordenlijst niet gevonden: {path}. "
            "Zorg dat het bestand bestaat."
        )
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    words = raw.get("words", [])
    # Deduplicate
    seen: set[str] = set()
    unique: list[str] = []
    for w in words:
        w = w.strip()
        if not w:
            continue
        key = w.strip().lower()
        if key not in seen:
            seen.add(key)
            unique.append(w)
    return unique


def _load_data(path: str) -> dict[str, list[str]]:
    """Load and validate a game JSON, return {category: [items]}."""
    if not os.path.isfile(path):
        raise FileNotFoundError(
            f"Woordenlijst niet gevonden: {path}. "
            "Zorg dat het bestand bestaat."
        )
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)

    if "categories" not in raw or not isinstance(raw["categories"], dict):
        raise ValueError(f"{path} moet een 'categories' object bevatten.")

    categories: dict[str, list[str]] = {}
    for name, info in raw["categories"].items():
        if not isinstance(info, dict) or "items" not in info:
            raise ValueError(f"Categorie '{name}' mist 'items' array.")
        seen: set[str] = set()
        unique: list[str] = []
        for item in info["items"]:
            item = item.strip()
            if not item:
                continue
            key = _normalize(item)
            if key not in seen:
                seen.add(key)
                unique.append(item)
        categories[name] = unique
    return categories


def _load_category_meta(path: str) -> dict[str, dict]:
    """Load label/color metadata from a game JSON."""
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    meta: dict[str, dict] = {}
    for name, info in raw.get("categories", {}).items():
        meta[name] = {
            "label": info.get("label", name.replace("_", " ").title()),
            "color": info.get("color", "#4F46E5"),
        }
    return meta


def _build_word_to_category(categories: dict[str, list[str]]) -> dict[str, str]:
    """Build a mapping from normalized word to category name."""
    mapping: dict[str, str] = {}
    for cat, items in categories.items():
        for item in items:
            mapping[_normalize(item)] = cat
    return mapping


def _gty_qr_filename(artist: str, title: str) -> str:
    """Build QR code filename matching the convention used during generation."""
    clean_artist = artist.replace("_", "")
    clean_title = title.replace("_", "")
    return f"{clean_artist}_{clean_title}.png"


def _load_gty_data(csv_path: str, qr_dir: str) -> tuple[dict[str, list[dict]], dict[str, int]]:
    """Load Guess the Year CSV, return ({origin: [song_dicts]}, {origin: max_position})."""
    if not os.path.isfile(csv_path):
        raise FileNotFoundError(
            f"GTY data niet gevonden: {csv_path}. "
            "Zorg dat het bestand bestaat."
        )
    songs_by_origin: dict[str, list[dict]] = {}
    max_pos: dict[str, int] = {}
    with open(csv_path, encoding="utf-8") as fh:
        reader = csv_mod.DictReader(fh)
        for row in reader:
            origin = row["origin"].strip()
            artist = row["artist"].strip()
            title = row["title"].strip()
            year_str = row.get("year", "").strip()
            pos_str = row.get("position", "").strip()
            if not artist or not title or not year_str:
                continue
            try:
                year = int(year_str)
            except ValueError:
                continue
            try:
                position = int(pos_str) if pos_str else 0
            except ValueError:
                position = 0
            qr_file = _gty_qr_filename(artist, title)
            qr_path = os.path.join(qr_dir, qr_file)
            song = {
                "artist": artist,
                "title": title,
                "year": year,
                "position": position,
                "origin": origin,
                "youtube_link": row.get("youtube_link", "").strip(),
                "spotify_link": row.get("spotify_link", "").strip(),
                "qr_file": qr_file if os.path.isfile(qr_path) else None,
            }
            songs_by_origin.setdefault(origin, []).append(song)
            if position > max_pos.get(origin, 0):
                max_pos[origin] = position
    return songs_by_origin, max_pos


GTY_ORIGIN_LABELS: dict[str, str] = {
    "joe_top2000": "Joe FM Top 2000",
    "Q_BE_top1000": "Q-Music BE Top 1000",
    "kink_top1500": "Kink Top 1500",
    "npo_radio5_evergreen_top1000": "NPO Radio 5 Evergreen Top 1000",
    "qmusic_foute_1500": "Q-Music Foute 1500",
    "radio1_classics1000": "Radio 1 Classics 1000",
    "radio_2_zomerhits": "Radio 2 Zomerhits",
    "radio_veronika_top3000": "Radio Veronica Top 3000",
    "willy_top1000": "Willy Top 1000",
    "QNL Top 1020": "Q-Music NL Top 1020",
    "songfestival_top50": "Songfestival Top 50",
}


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

GAME_DATA: dict[str, dict[str, list[str]]] = {
    "hints": _load_data(HINTS_DATA_PATH),
    "pictionary": _load_data(PICTIONARY_DATA_PATH),
}

GAME_META: dict[str, dict[str, dict]] = {
    "pictionary": _load_category_meta(PICTIONARY_DATA_PATH),
}

GAME_WORD_TO_CAT: dict[str, dict[str, str]] = {
    "pictionary": _build_word_to_category(GAME_DATA["pictionary"]),
}

GTY_SONGS: dict[str, list[dict]]
GTY_MAX_POS: dict[str, int]
GTY_SONGS, GTY_MAX_POS = _load_gty_data(GTY_DATA_PATH, GTY_QR_DIR)

THIRTY_SECONDS_WORDS: list[str] = _load_thirty_seconds_words(THIRTY_SECONDS_DATA_PATH)


def _load_taboe_cards(path: str) -> list[dict]:
    """Load Taboe cards: list of {word, taboo: [5 words]}."""
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    return raw.get("cards", [])


def _load_wie_ben_ik(path: str) -> dict[str, list[str]]:
    """Load Wie Ben Ik: {category: [person names]}."""
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    result: dict[str, list[str]] = {}
    for cat_key, info in raw.get("categories", {}).items():
        result[cat_key] = info.get("persons", [])
    return result


def _load_wie_ben_ik_meta(path: str) -> dict[str, str]:
    """Load Wie Ben Ik category labels."""
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    return {
        k: info.get("label", k.replace("_", " ").title())
        for k, info in raw.get("categories", {}).items()
    }


def _load_dit_of_dat(path: str) -> list[dict]:
    """Load Dit of Dat dilemmas."""
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    return raw.get("dilemmas", [])


def _load_bluf_statements(path: str) -> list[dict]:
    """Load Bluf statements with answers."""
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    return raw.get("statements", [])


TABOE_CARDS: list[dict] = _load_taboe_cards(TABOE_DATA_PATH)
WBI_PERSONS: dict[str, list[str]] = _load_wie_ben_ik(WIE_BEN_IK_DATA_PATH)
WBI_META: dict[str, str] = _load_wie_ben_ik_meta(WIE_BEN_IK_DATA_PATH)
DOD_DILEMMAS: list[dict] = _load_dit_of_dat(DIT_OF_DAT_DATA_PATH)
BLUF_STATEMENTS: list[dict] = _load_bluf_statements(BLUF_DATA_PATH)


def _load_schattingen(path: str) -> list[dict]:
    """Load Schattingen questions with answers."""
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


SCHATTINGEN_QUESTIONS: list[dict] = _load_schattingen(SCHATTINGEN_DATA_PATH)


def _load_emoji_quiz(path: str) -> list[dict]:
    """Load Emoji Quiz puzzles."""
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _load_ranking(path: str) -> list[dict]:
    """Load Ranking questions with items."""
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _load_categories(path: str) -> list[dict]:
    """Load Categories cards (category + letter)."""
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _load_timeline(path: str) -> list[dict]:
    """Load Timeline events with years."""
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


EMOJI_QUIZ_ITEMS: list[dict] = _load_emoji_quiz(EMOJI_QUIZ_DATA_PATH)
RANKING_QUESTIONS: list[dict] = _load_ranking(RANKING_DATA_PATH)
CATEGORIES_CARDS: list[dict] = _load_categories(CATEGORIES_DATA_PATH)
TIMELINE_EVENTS: list[dict] = _load_timeline(TIMELINE_DATA_PATH)

VALID_GAMES = {
    "hints", "pictionary", "guess-the-year", "thirty-seconds",
    "taboe", "wie-ben-ik", "muziekbingo", "dit-of-dat", "bluf",
    "schattingen", "emoji-quiz", "ranking", "categories", "timeline",
    "runner",
    "arena",
}

GAME_LABELS = {
    "hints": "Hints",
    "pictionary": "Pictionary",
    "guess-the-year": "Raad het Jaar",
    "thirty-seconds": "30 Seconds",
    "taboe": "Taboe",
    "wie-ben-ik": "Wie Ben Ik?",
    "muziekbingo": "Muziekbingo",
    "dit-of-dat": "Dit of Dat",
    "bluf": "Bluf",
    "schattingen": "Schattingen",
    "emoji-quiz": "Emoji Quiz",
    "ranking": "Ranking",
    "categories": "Categorieën",
    "timeline": "Tijdlijn",
    "runner": "Wachtkamer",
    "arena": "Arena",
}

# ---------------------------------------------------------------------------
# Session store (in-memory)
# ---------------------------------------------------------------------------

SESSION_STORE: dict[str, dict[str, Any]] = {}

_signer = URLSafeSerializer(SESSION_SECRET, salt="hints-session")
COOKIE_NAME = "hints_sid"


def _new_session_id() -> str:
    return _signer.dumps(os.urandom(16).hex())


def _get_session_id(request: Request) -> str | None:
    raw = request.cookies.get(COOKIE_NAME)
    if not raw:
        return None
    try:
        _signer.loads(raw)
        return raw
    except Exception:
        return None


def _ensure_session(request: Request, response: Response) -> str:
    sid = _get_session_id(request)
    if sid is None or sid not in SESSION_STORE:
        sid = _new_session_id()
        SESSION_STORE[sid] = {
            "used_by_selection": {},
            "selected_categories": [],
            "game": "hints",
            "ts": time.time(),
            "rate_tokens": RATE_LIMIT_PER_MIN,
            "rate_window_start": time.time(),
        }
        response.set_cookie(
            COOKIE_NAME, sid, httponly=True, samesite="lax", max_age=SESSION_TTL_SECONDS
        )
    else:
        SESSION_STORE[sid]["ts"] = time.time()
    return sid


def _selection_key(game: str, cats: list[str]) -> str:
    raw = f"{game}:" + ",".join(sorted(cats))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _rate_limit_ok(session: dict) -> bool:
    now = time.time()
    if now - session["rate_window_start"] > 60:
        session["rate_tokens"] = RATE_LIMIT_PER_MIN
        session["rate_window_start"] = now
    if session["rate_tokens"] <= 0:
        return False
    session["rate_tokens"] -= 1
    return True


# ---------------------------------------------------------------------------
# Background cleaner
# ---------------------------------------------------------------------------

async def _session_cleaner() -> None:
    while True:
        await asyncio.sleep(300)
        cutoff = time.time() - SESSION_TTL_SECONDS
        expired = [sid for sid, s in SESSION_STORE.items() if s["ts"] < cutoff]
        for sid in expired:
            SESSION_STORE.pop(sid, None)


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_session_cleaner())
    yield
    task.cancel()


app = FastAPI(title=APP_NAME, docs_url=None, redoc_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


# ---------------------------------------------------------------------------
# Middleware – security headers
# ---------------------------------------------------------------------------

@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "public, max-age=3600"
    return response


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    """Game picker landing page."""
    response = templates.TemplateResponse(
        request,
        "home.html",
        {"app_name": APP_NAME},
    )
    _ensure_session(request, response)
    return response


@app.post("/start")
async def start(request: Request):
    form = await request.form()
    game = form.get("game", "hints")
    if game not in VALID_GAMES:
        game = "hints"

    if game == "guess-the-year":
        selected: list[str] = form.getlist("categories")
        if "alle" in selected:
            selected = list(GTY_SONGS.keys())
        else:
            selected = [c for c in selected if c in GTY_SONGS]
        if not selected:
            return RedirectResponse(f"/{game}?error=no_selection", status_code=303)
        response = RedirectResponse("/gty/setup", status_code=303)
        sid = _ensure_session(request, response)
        SESSION_STORE[sid]["selected_categories"] = selected
        SESSION_STORE[sid]["game"] = game
        return response

    selected = form.getlist("categories")
    cats = GAME_DATA[game]

    if "alle" in selected:
        selected = list(cats.keys())
    else:
        selected = [c for c in selected if c in cats]

    if not selected:
        return RedirectResponse(f"/{game}?error=no_selection", status_code=303)

    response = RedirectResponse("/play", status_code=303)
    sid = _ensure_session(request, response)
    SESSION_STORE[sid]["selected_categories"] = selected
    SESSION_STORE[sid]["game"] = game
    return response


@app.get("/play", response_class=HTMLResponse)
async def play(request: Request):
    response = templates.TemplateResponse(
        request,
        "play.html",
        {"app_name": APP_NAME},
    )
    sid = _ensure_session(request, response)
    game = SESSION_STORE[sid].get("game", "hints")
    # Re-render with game context
    response = templates.TemplateResponse(
        request,
        "play.html",
        {
            "app_name": APP_NAME,
            "game": game,
            "game_label": GAME_LABELS.get(game, game),
        },
    )
    return response


@app.post("/next")
async def next_word(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]

    if not _rate_limit_ok(session):
        return JSONResponse(
            {"error": "Te veel verzoeken. Wacht even."},
            status_code=429,
        )

    game = session.get("game", "hints")
    cats = GAME_DATA.get(game, {})
    selected = session.get("selected_categories", [])
    if not selected:
        return JSONResponse(
            {"error": "Geen categorieën geselecteerd."},
            status_code=400,
        )

    sel_key = _selection_key(game, selected)
    used: set[str] = session["used_by_selection"].setdefault(sel_key, set())

    pool: list[str] = []
    for cat in selected:
        pool.extend(cats.get(cat, []))

    available = [w for w in pool if _normalize(w) not in used]

    if not available:
        return Response(
            status_code=204,
            headers={"X-Empty-Pool": "true"},
        )

    word = random.choice(available)
    used.add(_normalize(word))

    result: dict[str, Any] = {"word": word}

    # For Pictionary, include the category info
    if game == "pictionary":
        w2c = GAME_WORD_TO_CAT.get("pictionary", {})
        cat_name = w2c.get(_normalize(word), "")
        meta = GAME_META.get("pictionary", {}).get(cat_name, {})
        result["category"] = meta.get("label", cat_name.replace("_", " ").title())
        result["category_color"] = meta.get("color", "#4F46E5")

    return JSONResponse(result)


@app.post("/reset_used")
async def reset_used(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    game = session.get("game", "hints")
    selected = session.get("selected_categories", [])
    if selected:
        sel_key = _selection_key(game, selected)
        session["used_by_selection"].pop(sel_key, None)
    return JSONResponse({"status": "ok"})


@app.get("/categories")
async def categories(request: Request):
    """Return categories for the session's active game, or hints by default."""
    response = Response()
    sid = _ensure_session(request, response)
    game = SESSION_STORE[sid].get("game", "hints")
    cats = GAME_DATA.get(game, {})
    return JSONResponse([
        {"name": name, "count": len(items)}
        for name, items in cats.items()
    ])


@app.get("/healthz")
async def healthz():
    return JSONResponse({"status": "ok"})


@app.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request):
    response = templates.TemplateResponse(
        request,
        "settings.html",
        {"app_name": APP_NAME},
    )
    _ensure_session(request, response)
    return response


# ---------------------------------------------------------------------------
# GTY (Guess the Year) routes
# ---------------------------------------------------------------------------

def _gty_song_key(song: dict) -> str:
    """Unique key for deduplication of played songs."""
    return _normalize(f"{song['artist']}|{song['title']}")


def _ensure_gty(session: dict) -> dict:
    """Ensure the session has a gty sub-dict, return it."""
    if "gty" not in session:
        session["gty"] = {
            "num_teams": 2,
            "rounds_to_win": 5,
            "team_names": ["Team 1", "Team 2"],
            "scores": [0, 0],
            "current_song": None,
            "round_number": 0,
            "revealed": False,
            "history": [],
            "winner": None,
            "team_years": [[], []],
            "jetons": [0, 0],
            "difficulty": "normaal",
        }
    gty = session["gty"]
    if "team_years" not in gty:
        gty["team_years"] = [[] for _ in range(gty["num_teams"])]
    if "jetons" not in gty:
        gty["jetons"] = [0] * gty["num_teams"]
    if "difficulty" not in gty:
        gty["difficulty"] = "normaal"
    return gty


@app.get("/gty/setup", response_class=HTMLResponse)
async def gty_setup(request: Request):
    response = templates.TemplateResponse(
        request,
        "gty_setup.html",
        {"app_name": APP_NAME},
    )
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    if session.get("game") != "guess-the-year" or not session.get("selected_categories"):
        return RedirectResponse("/guess-the-year", status_code=303)
    return response


@app.post("/gty/start")
async def gty_start(request: Request):
    form = await request.form()
    response = RedirectResponse("/gty/play", status_code=303)
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]

    num_teams = min(max(int(form.get("num_teams", 2)), 2), 6)

    # Rounds to win: custom field takes priority over radio
    custom_rounds = form.get("rounds_to_win_custom", "").strip()
    if custom_rounds:
        try:
            rounds_to_win = max(1, min(99, int(custom_rounds)))
        except ValueError:
            rounds_to_win = 5
    else:
        rounds_to_win = int(form.get("rounds_to_win", 5))

    difficulty = form.get("difficulty", "normaal")
    if difficulty not in ("makkelijk", "normaal", "moeilijk"):
        difficulty = "normaal"

    team_names = []
    for i in range(num_teams):
        name = form.get(f"team_{i}", "").strip()
        team_names.append(name or f"Team {i + 1}")

    gty = _ensure_gty(session)
    gty["num_teams"] = num_teams
    gty["rounds_to_win"] = rounds_to_win
    gty["team_names"] = team_names
    gty["scores"] = [0] * num_teams
    gty["current_song"] = None
    gty["round_number"] = 0
    gty["revealed"] = False
    gty["history"] = []
    gty["winner"] = None
    gty["team_years"] = [[] for _ in range(num_teams)]
    gty["jetons"] = [0] * num_teams
    gty["difficulty"] = difficulty

    return response


@app.get("/gty/play", response_class=HTMLResponse)
async def gty_play(request: Request):
    response = templates.TemplateResponse(
        request,
        "gty_play.html",
        {"app_name": APP_NAME},
    )
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    if session.get("game") != "guess-the-year":
        return RedirectResponse("/guess-the-year", status_code=303)
    if "gty" not in session:
        return RedirectResponse("/gty/setup", status_code=303)
    return response


@app.post("/gty/next")
async def gty_next(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]

    if not _rate_limit_ok(session):
        return JSONResponse({"error": "Te veel verzoeken. Wacht even."}, status_code=429)

    gty = _ensure_gty(session)
    if gty["winner"] is not None:
        return JSONResponse({"error": "Het spel is afgelopen."}, status_code=400)

    selected = session.get("selected_categories", [])
    sel_key = _selection_key("guess-the-year", selected)
    used: set[str] = session["used_by_selection"].setdefault(sel_key, set())

    pool: list[dict] = []
    for origin in selected:
        pool.extend(GTY_SONGS.get(origin, []))

    # Filter on difficulty
    difficulty = gty.get("difficulty", "normaal")
    if difficulty != "normaal":
        filtered: list[dict] = []
        for song in pool:
            mp = GTY_MAX_POS.get(song["origin"], 1)
            ratio = song["position"] / mp if mp > 0 else 0
            if difficulty == "makkelijk" and ratio <= 0.33:
                filtered.append(song)
            elif difficulty == "moeilijk" and ratio > 0.67:
                filtered.append(song)
        pool = filtered if filtered else pool  # fallback to all if filter empties pool

    available = [s for s in pool if _gty_song_key(s) not in used]

    if not available:
        return Response(status_code=204, headers={"X-Empty-Pool": "true"})

    song = random.choice(available)
    used.add(_gty_song_key(song))

    gty["current_song"] = song
    gty["revealed"] = False
    gty["round_number"] += 1

    result: dict[str, Any] = {
        "round": gty["round_number"],
        "youtube_link": song["youtube_link"],
        "spotify_link": song["spotify_link"],
        "qr_url": f"/gty/qr/{song['qr_file']}" if song["qr_file"] else None,
    }
    return JSONResponse(result)


@app.post("/gty/reveal")
async def gty_reveal(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    gty = _ensure_gty(session)

    song = gty.get("current_song")
    if not song:
        return JSONResponse({"error": "Geen huidig nummer."}, status_code=400)

    gty["revealed"] = True
    return JSONResponse({
        "artist": song["artist"],
        "title": song["title"],
        "year": song["year"],
    })


@app.post("/gty/award")
async def gty_award(request: Request):
    form = await request.form()
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    gty = _ensure_gty(session)

    if not gty.get("revealed"):
        return JSONResponse({"error": "Onthul eerst het antwoord."}, status_code=400)

    team_idx = int(form.get("team", 0))
    if team_idx < 0 or team_idx >= gty["num_teams"]:
        return JSONResponse({"error": "Ongeldig team."}, status_code=400)

    song = gty.get("current_song")
    year = song["year"] if song else None

    gty["scores"][team_idx] += 1
    if year is not None:
        gty["team_years"][team_idx].append(year)
        gty["team_years"][team_idx].sort()
    gty["history"].append({"team": team_idx, "round": gty["round_number"], "year": year})

    winner = None
    if gty["scores"][team_idx] >= gty["rounds_to_win"]:
        winner = gty["team_names"][team_idx]
        gty["winner"] = winner

    return JSONResponse({
        "scores": gty["scores"],
        "team_names": gty["team_names"],
        "team_years": gty["team_years"],
        "jetons": gty["jetons"],
        "winner": winner,
    })


@app.post("/gty/undo")
async def gty_undo(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    gty = _ensure_gty(session)

    if not gty["history"]:
        return JSONResponse({"error": "Niets om ongedaan te maken."}, status_code=400)

    last = gty["history"].pop()
    gty["scores"][last["team"]] -= 1
    year = last.get("year")
    if year is not None and year in gty["team_years"][last["team"]]:
        gty["team_years"][last["team"]].remove(year)
    gty["winner"] = None

    return JSONResponse({
        "scores": gty["scores"],
        "team_names": gty["team_names"],
        "team_years": gty["team_years"],
        "jetons": gty["jetons"],
    })


@app.post("/gty/jeton")
async def gty_jeton(request: Request):
    form = await request.form()
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    gty = _ensure_gty(session)

    team_idx = int(form.get("team", 0))
    if team_idx < 0 or team_idx >= gty["num_teams"]:
        return JSONResponse({"error": "Ongeldig team."}, status_code=400)

    action = form.get("action", "")
    if action == "add":
        gty["jetons"][team_idx] += 1
    elif action == "use":
        if gty["jetons"][team_idx] <= 0:
            return JSONResponse({"error": "Geen jetons meer."}, status_code=400)
        gty["jetons"][team_idx] -= 1
    else:
        return JSONResponse({"error": "Ongeldige actie."}, status_code=400)

    return JSONResponse({
        "jetons": gty["jetons"],
        "team_names": gty["team_names"],
    })


@app.get("/gty/state")
async def gty_state(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    gty = _ensure_gty(session)

    song = gty.get("current_song")
    result: dict[str, Any] = {
        "num_teams": gty["num_teams"],
        "rounds_to_win": gty["rounds_to_win"],
        "team_names": gty["team_names"],
        "scores": gty["scores"],
        "round_number": gty["round_number"],
        "revealed": gty["revealed"],
        "winner": gty["winner"],
        "team_years": gty["team_years"],
        "jetons": gty["jetons"],
        "difficulty": gty.get("difficulty", "normaal"),
    }

    if song:
        result["youtube_link"] = song["youtube_link"]
        result["spotify_link"] = song["spotify_link"]
        result["qr_url"] = f"/gty/qr/{song['qr_file']}" if song["qr_file"] else None
        if gty["revealed"]:
            result["artist"] = song["artist"]
            result["title"] = song["title"]
            result["year"] = song["year"]

    return JSONResponse(result)


@app.get("/gty/qr/{filename}")
async def gty_qr(filename: str):
    """Serve a QR code image with path-traversal protection."""
    if not re.match(r'^[\w\s\'\-\(\),\.!&#+]+\.png$', filename):
        return JSONResponse({"error": "Ongeldige bestandsnaam."}, status_code=400)
    path = os.path.join(GTY_QR_DIR, filename)
    resolved = os.path.realpath(path)
    qr_base = os.path.realpath(GTY_QR_DIR)
    if not resolved.startswith(qr_base):
        return JSONResponse({"error": "Ongeldige bestandsnaam."}, status_code=400)
    if not os.path.isfile(resolved):
        return JSONResponse({"error": "QR code niet gevonden."}, status_code=404)
    return FileResponse(resolved, media_type="image/png")


# ---------------------------------------------------------------------------
# 30 Seconds routes
# ---------------------------------------------------------------------------

def _ensure_ts(session: dict) -> dict:
    """Ensure the session has a thirty-seconds sub-dict, return it."""
    if "ts_game" not in session:
        session["ts_game"] = {
            "num_teams": 2,
            "finish_score": 30,
            "team_names": ["Team 1", "Team 2"],
            "positions": [0, 0],
            "current_team_idx": 0,
            "current_words": [],
            "handicap": None,
            "round_number": 0,
            "winner": None,
            "used_words": set(),
            "history": [],
        }
    return session["ts_game"]


@app.get("/ts/setup", response_class=HTMLResponse)
async def ts_setup(request: Request):
    response = templates.TemplateResponse(
        request,
        "ts_setup.html",
        {"app_name": APP_NAME},
    )
    _ensure_session(request, response)
    return response


@app.post("/ts/start")
async def ts_start(request: Request):
    form = await request.form()
    response = RedirectResponse("/ts/play", status_code=303)
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]

    num_teams = min(max(int(form.get("num_teams", 2)), 2), 6)
    finish_score = max(10, min(60, int(form.get("finish_score", 30))))

    team_names = []
    for i in range(num_teams):
        name = form.get(f"team_{i}", "").strip()
        team_names.append(name or f"Team {i + 1}")

    ts = _ensure_ts(session)
    ts["num_teams"] = num_teams
    ts["finish_score"] = finish_score
    ts["team_names"] = team_names
    ts["positions"] = [0] * num_teams
    ts["current_team_idx"] = 0
    ts["current_words"] = []
    ts["handicap"] = None
    ts["round_number"] = 0
    ts["winner"] = None
    ts["used_words"] = set()
    ts["history"] = []
    session["game"] = "thirty-seconds"

    return response


@app.get("/ts/play", response_class=HTMLResponse)
async def ts_play(request: Request):
    response = templates.TemplateResponse(
        request,
        "ts_play.html",
        {"app_name": APP_NAME},
    )
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    if "ts_game" not in session:
        return RedirectResponse("/thirty-seconds", status_code=303)
    return response


@app.get("/ts/state")
async def ts_state(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    ts = _ensure_ts(session)

    result: dict[str, Any] = {
        "num_teams": ts["num_teams"],
        "finish_score": ts["finish_score"],
        "team_names": ts["team_names"],
        "positions": ts["positions"],
        "current_team_idx": ts["current_team_idx"],
        "handicap": ts["handicap"],
        "round_number": ts["round_number"],
        "winner": ts["winner"],
        "current_words": ts["current_words"],
        "total_words": len(THIRTY_SECONDS_WORDS),
        "used_words_count": len(ts.get("used_words", set())),
    }
    return JSONResponse(result)


@app.post("/ts/roll")
async def ts_roll(request: Request):
    """Roll the 30 seconds dice: returns 0, 1, or 2 (each with equal probability)."""
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    ts = _ensure_ts(session)

    if ts["winner"] is not None:
        return JSONResponse({"error": "Het spel is afgelopen."}, status_code=400)

    # Roll the dice: 0, 1, or 2 (6-sided die: two faces per value)
    handicap = random.choice([0, 0, 1, 1, 2, 2])
    ts["handicap"] = handicap

    return JSONResponse({"handicap": handicap})


@app.post("/ts/draw")
async def ts_draw(request: Request):
    """Draw 5 new words for the current turn."""
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    ts = _ensure_ts(session)

    if ts["winner"] is not None:
        return JSONResponse({"error": "Het spel is afgelopen."}, status_code=400)
    if ts["handicap"] is None:
        return JSONResponse({"error": "Gooi eerst de dobbelsteen."}, status_code=400)

    used = ts.get("used_words", set())
    available = [w for w in THIRTY_SECONDS_WORDS if w.strip().lower() not in used]

    if len(available) < 5:
        # Reset pool if running low
        ts["used_words"] = set()
        available = list(THIRTY_SECONDS_WORDS)

    words = random.sample(available, min(5, len(available)))
    for w in words:
        ts["used_words"].add(w.strip().lower())

    ts["current_words"] = words
    ts["round_number"] += 1

    return JSONResponse({
        "words": words,
        "round_number": ts["round_number"],
        "current_team": ts["team_names"][ts["current_team_idx"]],
        "current_team_idx": ts["current_team_idx"],
    })


@app.post("/ts/score")
async def ts_score(request: Request):
    """Submit the turn result: how many words were guessed correctly."""
    form = await request.form()
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    ts = _ensure_ts(session)

    if ts["winner"] is not None:
        return JSONResponse({"error": "Het spel is afgelopen."}, status_code=400)

    correct = int(form.get("correct", 0))
    correct = max(0, min(5, correct))
    handicap = ts.get("handicap", 0) or 0

    steps = max(0, correct - handicap)
    team_idx = ts["current_team_idx"]
    ts["positions"][team_idx] += steps

    # Record history
    ts["history"].append({
        "round": ts["round_number"],
        "team": team_idx,
        "correct": correct,
        "handicap": handicap,
        "steps": steps,
    })

    # Check for winner
    winner = None
    if ts["positions"][team_idx] >= ts["finish_score"]:
        winner = ts["team_names"][team_idx]
        ts["winner"] = winner

    # Advance to next team
    ts["current_team_idx"] = (team_idx + 1) % ts["num_teams"]
    ts["handicap"] = None
    ts["current_words"] = []

    return JSONResponse({
        "positions": ts["positions"],
        "team_names": ts["team_names"],
        "steps": steps,
        "correct": correct,
        "handicap": handicap,
        "current_team_idx": ts["current_team_idx"],
        "winner": winner,
        "finish_score": ts["finish_score"],
    })


@app.post("/ts/undo")
async def ts_undo(request: Request):
    """Undo the last scoring action."""
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    ts = _ensure_ts(session)

    if not ts["history"]:
        return JSONResponse({"error": "Niets om ongedaan te maken."}, status_code=400)

    last = ts["history"].pop()
    ts["positions"][last["team"]] -= last["steps"]
    ts["positions"][last["team"]] = max(0, ts["positions"][last["team"]])
    ts["current_team_idx"] = last["team"]
    ts["winner"] = None

    return JSONResponse({
        "positions": ts["positions"],
        "team_names": ts["team_names"],
        "current_team_idx": ts["current_team_idx"],
        "finish_score": ts["finish_score"],
    })


# ---------------------------------------------------------------------------
# Taboe routes
# ---------------------------------------------------------------------------

def _ensure_taboe(session: dict) -> dict:
    if "taboe_game" not in session:
        session["taboe_game"] = {
            "num_teams": 2,
            "finish_score": 25,
            "team_names": ["Team 1", "Team 2"],
            "positions": [0, 0],
            "current_team_idx": 0,
            "current_card": None,
            "round_number": 0,
            "turn_correct": 0,
            "turn_taboe": 0,
            "turn_active": False,
            "winner": None,
            "used_indices": set(),
            "history": [],
        }
    return session["taboe_game"]


@app.get("/taboe/setup", response_class=HTMLResponse)
async def taboe_setup(request: Request):
    response = templates.TemplateResponse(request, "taboe_setup.html", {"app_name": APP_NAME})
    _ensure_session(request, response)
    return response


@app.post("/taboe/start")
async def taboe_start(request: Request):
    form = await request.form()
    response = RedirectResponse("/taboe/play", status_code=303)
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]

    num_teams = min(max(int(form.get("num_teams", 2)), 2), 6)
    finish_score = max(10, min(60, int(form.get("finish_score", 25))))
    team_names = [form.get(f"team_{i}", "").strip() or f"Team {i+1}" for i in range(num_teams)]

    tb = _ensure_taboe(session)
    tb.update({
        "num_teams": num_teams, "finish_score": finish_score,
        "team_names": team_names, "positions": [0] * num_teams,
        "current_team_idx": 0, "current_card": None, "round_number": 0,
        "turn_correct": 0, "turn_taboe": 0, "turn_active": False,
        "winner": None, "used_indices": set(), "history": [],
    })
    session["game"] = "taboe"
    return response


@app.get("/taboe/play", response_class=HTMLResponse)
async def taboe_play(request: Request):
    response = templates.TemplateResponse(request, "taboe_play.html", {"app_name": APP_NAME})
    sid = _ensure_session(request, response)
    if "taboe_game" not in SESSION_STORE[sid]:
        return RedirectResponse("/taboe", status_code=303)
    return response


@app.get("/taboe/state")
async def taboe_state(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    tb = _ensure_taboe(SESSION_STORE[sid])
    return JSONResponse({
        "num_teams": tb["num_teams"], "finish_score": tb["finish_score"],
        "team_names": tb["team_names"], "positions": tb["positions"],
        "current_team_idx": tb["current_team_idx"],
        "round_number": tb["round_number"],
        "turn_correct": tb["turn_correct"], "turn_taboe": tb["turn_taboe"],
        "turn_active": tb["turn_active"],
        "current_card": tb["current_card"], "winner": tb["winner"],
        "total_cards": len(TABOE_CARDS),
    })


@app.post("/taboe/draw")
async def taboe_draw(request: Request):
    """Draw a new Taboe card."""
    response = Response()
    sid = _ensure_session(request, response)
    tb = _ensure_taboe(SESSION_STORE[sid])
    if tb["winner"]:
        return JSONResponse({"error": "Het spel is afgelopen."}, status_code=400)

    used = tb.get("used_indices", set())
    available = [i for i in range(len(TABOE_CARDS)) if i not in used]
    if not available:
        tb["used_indices"] = set()
        available = list(range(len(TABOE_CARDS)))

    idx = random.choice(available)
    tb["used_indices"].add(idx)
    card = TABOE_CARDS[idx]
    tb["current_card"] = card

    if not tb["turn_active"]:
        tb["turn_active"] = True
        tb["turn_correct"] = 0
        tb["turn_taboe"] = 0
        tb["round_number"] += 1

    return JSONResponse({"word": card["word"], "taboo": card["taboo"]})


@app.post("/taboe/correct")
async def taboe_correct(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    tb = _ensure_taboe(SESSION_STORE[sid])
    tb["turn_correct"] += 1
    return JSONResponse({"turn_correct": tb["turn_correct"], "turn_taboe": tb["turn_taboe"]})


@app.post("/taboe/taboe_fout")
async def taboe_fout(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    tb = _ensure_taboe(SESSION_STORE[sid])
    tb["turn_taboe"] += 1
    return JSONResponse({"turn_correct": tb["turn_correct"], "turn_taboe": tb["turn_taboe"]})


@app.post("/taboe/end_turn")
async def taboe_end_turn(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    tb = _ensure_taboe(SESSION_STORE[sid])

    steps = max(0, tb["turn_correct"] - tb["turn_taboe"])
    team_idx = tb["current_team_idx"]
    tb["positions"][team_idx] += steps
    tb["history"].append({"round": tb["round_number"], "team": team_idx, "correct": tb["turn_correct"], "taboe": tb["turn_taboe"], "steps": steps})
    tb["turn_active"] = False
    tb["current_card"] = None

    winner = None
    if tb["positions"][team_idx] >= tb["finish_score"]:
        winner = tb["team_names"][team_idx]
        tb["winner"] = winner

    tb["current_team_idx"] = (team_idx + 1) % tb["num_teams"]
    tb["turn_correct"] = 0
    tb["turn_taboe"] = 0

    return JSONResponse({"positions": tb["positions"], "team_names": tb["team_names"], "steps": steps, "current_team_idx": tb["current_team_idx"], "winner": winner, "finish_score": tb["finish_score"]})


@app.post("/taboe/undo")
async def taboe_undo(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    tb = _ensure_taboe(SESSION_STORE[sid])
    if not tb["history"]:
        return JSONResponse({"error": "Niets om ongedaan te maken."}, status_code=400)
    last = tb["history"].pop()
    tb["positions"][last["team"]] = max(0, tb["positions"][last["team"]] - last["steps"])
    tb["current_team_idx"] = last["team"]
    tb["winner"] = None
    return JSONResponse({"positions": tb["positions"], "team_names": tb["team_names"], "current_team_idx": tb["current_team_idx"], "finish_score": tb["finish_score"]})


# ---------------------------------------------------------------------------
# Wie Ben Ik routes
# ---------------------------------------------------------------------------

@app.get("/wbi/setup", response_class=HTMLResponse)
async def wbi_setup(request: Request):
    meta = {k: {"label": v} for k, v in WBI_META.items()}
    response = templates.TemplateResponse(request, "wbi_setup.html", {
        "app_name": APP_NAME,
        "categories": {k: len(v) for k, v in WBI_PERSONS.items()},
        "category_meta": meta,
    })
    _ensure_session(request, response)
    return response


@app.post("/wbi/start")
async def wbi_start(request: Request):
    form = await request.form()
    response = RedirectResponse("/wbi/play", status_code=303)
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]

    selected = form.getlist("categories")
    if "alle" in selected:
        selected = list(WBI_PERSONS.keys())
    else:
        selected = [c for c in selected if c in WBI_PERSONS]
    if not selected:
        return RedirectResponse("/wbi/setup?error=no_selection", status_code=303)

    persons: list[str] = []
    for cat in selected:
        persons.extend(WBI_PERSONS.get(cat, []))
    random.shuffle(persons)

    session["wbi_game"] = {
        "persons": persons,
        "current_idx": -1,
        "total": len(persons),
    }
    session["game"] = "wie-ben-ik"
    return response


@app.get("/wbi/play", response_class=HTMLResponse)
async def wbi_play(request: Request):
    response = templates.TemplateResponse(request, "wbi_play.html", {"app_name": APP_NAME})
    sid = _ensure_session(request, response)
    if "wbi_game" not in SESSION_STORE[sid]:
        return RedirectResponse("/wie-ben-ik", status_code=303)
    return response


@app.post("/wbi/next")
async def wbi_next(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    wbi = SESSION_STORE[sid].get("wbi_game")
    if not wbi:
        return JSONResponse({"error": "Geen spel actief."}, status_code=400)
    wbi["current_idx"] += 1
    if wbi["current_idx"] >= wbi["total"]:
        return Response(status_code=204)
    return JSONResponse({"person": wbi["persons"][wbi["current_idx"]], "number": wbi["current_idx"] + 1, "total": wbi["total"]})


# ---------------------------------------------------------------------------
# Muziekbingo routes (single shared card, QR-code based)
# ---------------------------------------------------------------------------

PLAYER_COLORS = ['#4F46E5', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899']


def _ensure_mbingo(session: dict) -> dict:
    if "mbingo_game" not in session:
        session["mbingo_game"] = {
            "num_players": 2, "player_names": ["Speler 1", "Speler 2"],
            "card_size": 4,
            "card": [],        # list of {artist, title, claimed_by: int|null}
            "play_queue": [],   # indices into card[] in random order
            "play_idx": -1,     # current position in play_queue
            "current_song": None,  # the song currently playing (dict)
            "current_card_idx": None,  # the card cell index of current song
            "revealed": False,
            "all_songs": [],
        }
    return session["mbingo_game"]


@app.get("/mbingo/setup", response_class=HTMLResponse)
async def mbingo_setup(request: Request):
    meta = {name: {"label": GTY_ORIGIN_LABELS.get(name, name.replace("_", " ").title())} for name in GTY_SONGS}
    response = templates.TemplateResponse(request, "mbingo_setup.html", {
        "app_name": APP_NAME,
        "categories": {name: len(items) for name, items in GTY_SONGS.items()},
        "category_meta": meta,
    })
    _ensure_session(request, response)
    return response


@app.post("/mbingo/start")
async def mbingo_start(request: Request):
    form = await request.form()
    response = RedirectResponse("/mbingo/play", status_code=303)
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]

    selected = form.getlist("categories")
    if "alle" in selected:
        selected = list(GTY_SONGS.keys())
    else:
        selected = [c for c in selected if c in GTY_SONGS]
    if not selected:
        return RedirectResponse("/mbingo/setup?error=no_selection", status_code=303)

    num_players = min(max(int(form.get("num_players", 2)), 2), 6)
    player_names = [form.get(f"player_{i}", "").strip() or f"Speler {i+1}" for i in range(num_players)]
    card_size = int(form.get("card_size", 4))
    if card_size not in (3, 4, 5):
        card_size = 4

    pool: list[dict] = []
    for origin in selected:
        pool.extend(GTY_SONGS.get(origin, []))

    cells_needed = card_size * card_size
    card_songs = random.sample(pool, min(cells_needed, len(pool)))

    card = []
    for s in card_songs:
        card.append({"artist": s["artist"], "title": s["title"], "claimed_by": None,
                      "qr_file": s.get("qr_file"), "youtube_link": s.get("youtube_link", ""),
                      "spotify_link": s.get("spotify_link", "")})

    play_queue = list(range(len(card)))
    random.shuffle(play_queue)

    mb = _ensure_mbingo(session)
    mb.update({
        "num_players": num_players, "player_names": player_names,
        "card_size": card_size, "card": card,
        "play_queue": play_queue, "play_idx": -1,
        "current_song": None, "current_card_idx": None,
        "revealed": False, "all_songs": pool,
    })
    session["game"] = "muziekbingo"
    session["selected_categories"] = selected
    return response


@app.get("/mbingo/play", response_class=HTMLResponse)
async def mbingo_play(request: Request):
    response = templates.TemplateResponse(request, "mbingo_play.html", {"app_name": APP_NAME})
    sid = _ensure_session(request, response)
    if "mbingo_game" not in SESSION_STORE[sid]:
        return RedirectResponse("/muziekbingo", status_code=303)
    return response


@app.get("/mbingo/state")
async def mbingo_state(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    mb = _ensure_mbingo(SESSION_STORE[sid])

    # Build card info (hide song identity for unclaimed+unrevealed cells if a song is active)
    card_out = []
    for i, cell in enumerate(mb["card"]):
        card_out.append({
            "artist": cell["artist"], "title": cell["title"],
            "claimed_by": cell["claimed_by"],
        })

    result: dict[str, Any] = {
        "num_players": mb["num_players"], "player_names": mb["player_names"],
        "card_size": mb["card_size"], "card": card_out,
        "revealed": mb["revealed"],
        "play_idx": mb["play_idx"],
        "total_songs": len(mb["play_queue"]),
    }

    if mb["current_song"] and not mb["revealed"]:
        song = mb["current_song"]
        result["qr_url"] = f"/gty/qr/{song['qr_file']}" if song.get("qr_file") else None
        result["youtube_link"] = song.get("youtube_link", "")
        result["spotify_link"] = song.get("spotify_link", "")
    elif mb["current_song"] and mb["revealed"]:
        song = mb["current_song"]
        result["qr_url"] = f"/gty/qr/{song['qr_file']}" if song.get("qr_file") else None
        result["youtube_link"] = song.get("youtube_link", "")
        result["spotify_link"] = song.get("spotify_link", "")
        result["current_card_idx"] = mb["current_card_idx"]
        result["current_artist"] = song["artist"]
        result["current_title"] = song["title"]

    return JSONResponse(result)


@app.post("/mbingo/next_song")
async def mbingo_next_song(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    mb = _ensure_mbingo(SESSION_STORE[sid])

    mb["play_idx"] += 1
    if mb["play_idx"] >= len(mb["play_queue"]):
        return Response(status_code=204)

    card_idx = mb["play_queue"][mb["play_idx"]]
    song = mb["card"][card_idx]
    mb["current_song"] = song
    mb["current_card_idx"] = card_idx
    mb["revealed"] = False

    result: dict[str, Any] = {
        "qr_url": f"/gty/qr/{song['qr_file']}" if song.get("qr_file") else None,
        "youtube_link": song.get("youtube_link", ""),
        "spotify_link": song.get("spotify_link", ""),
        "song_number": mb["play_idx"] + 1,
        "total_songs": len(mb["play_queue"]),
    }
    return JSONResponse(result)


@app.post("/mbingo/claim")
async def mbingo_claim(request: Request):
    form = await request.form()
    response = Response()
    sid = _ensure_session(request, response)
    mb = _ensure_mbingo(SESSION_STORE[sid])

    if mb["current_song"] is None:
        return JSONResponse({"error": "Geen nummer actief."}, status_code=400)
    if mb["revealed"]:
        return JSONResponse({"error": "Al onthuld."}, status_code=400)

    player_idx = int(form.get("player", 0))
    cell_idx = int(form.get("cell", -1))

    if cell_idx < 0 or cell_idx >= len(mb["card"]):
        return JSONResponse({"error": "Ongeldig veld."}, status_code=400)
    if player_idx < 0 or player_idx >= mb["num_players"]:
        return JSONResponse({"error": "Ongeldige speler."}, status_code=400)

    # Check if this cell is the current song
    if cell_idx != mb["current_card_idx"]:
        return JSONResponse({"correct": False, "message": "Fout! Dat is niet het juiste nummer."})

    # Check if already claimed
    if mb["card"][cell_idx]["claimed_by"] is not None:
        return JSONResponse({"correct": False, "message": "Dit veld is al geclaimd."})

    # Correct claim!
    mb["card"][cell_idx]["claimed_by"] = player_idx
    mb["revealed"] = True
    song = mb["current_song"]

    # Calculate scores
    scores = [0] * mb["num_players"]
    for cell in mb["card"]:
        if cell["claimed_by"] is not None:
            scores[cell["claimed_by"]] += 1

    return JSONResponse({
        "correct": True,
        "cell_idx": cell_idx,
        "player_idx": player_idx,
        "artist": song["artist"],
        "title": song["title"],
        "scores": scores,
        "player_names": mb["player_names"],
    })


@app.post("/mbingo/reveal")
async def mbingo_reveal(request: Request):
    """Reveal the current song without anyone claiming it (skip/pass)."""
    response = Response()
    sid = _ensure_session(request, response)
    mb = _ensure_mbingo(SESSION_STORE[sid])

    if mb["current_song"] is None:
        return JSONResponse({"error": "Geen nummer actief."}, status_code=400)

    mb["revealed"] = True
    song = mb["current_song"]
    card_idx = mb["current_card_idx"]

    return JSONResponse({
        "card_idx": card_idx,
        "artist": song["artist"],
        "title": song["title"],
    })


# ---------------------------------------------------------------------------
# Dit of Dat routes
# ---------------------------------------------------------------------------

@app.get("/dod/play", response_class=HTMLResponse)
async def dod_play(request: Request):
    response = templates.TemplateResponse(request, "dod_play.html", {"app_name": APP_NAME})
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    if "dod_game" not in session:
        indices = list(range(len(DOD_DILEMMAS)))
        random.shuffle(indices)
        session["dod_game"] = {"order": indices, "current_idx": -1}
    session["game"] = "dit-of-dat"
    return response


@app.post("/dod/next")
async def dod_next(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    dod = session.get("dod_game")
    if not dod:
        return JSONResponse({"error": "Geen spel actief."}, status_code=400)
    dod["current_idx"] += 1
    if dod["current_idx"] >= len(dod["order"]):
        return Response(status_code=204)
    dilemma = DOD_DILEMMAS[dod["order"][dod["current_idx"]]]
    return JSONResponse({"option_a": dilemma["option_a"], "option_b": dilemma["option_b"], "number": dod["current_idx"] + 1, "total": len(dod["order"])})


@app.post("/dod/reset")
async def dod_reset(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    indices = list(range(len(DOD_DILEMMAS)))
    random.shuffle(indices)
    session["dod_game"] = {"order": indices, "current_idx": -1}
    return JSONResponse({"status": "ok"})


# ---------------------------------------------------------------------------
# Bluf routes
# ---------------------------------------------------------------------------

def _ensure_bluf(session: dict) -> dict:
    if "bluf_game" not in session:
        session["bluf_game"] = {
            "num_teams": 2, "points_to_win": 10,
            "team_names": ["Team 1", "Team 2"],
            "scores": [0, 0],
            "current_statement": None, "current_idx": None,
            "round_number": 0, "revealed": False,
            "votes": {},
            "winner": None, "used_indices": set(), "history": [],
        }
    return session["bluf_game"]


@app.get("/bluf/setup", response_class=HTMLResponse)
async def bluf_setup(request: Request):
    response = templates.TemplateResponse(request, "bluf_setup.html", {"app_name": APP_NAME})
    _ensure_session(request, response)
    return response


@app.post("/bluf/start")
async def bluf_start(request: Request):
    form = await request.form()
    response = RedirectResponse("/bluf/play", status_code=303)
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]

    num_teams = min(max(int(form.get("num_teams", 2)), 2), 6)
    points_to_win = max(3, min(30, int(form.get("points_to_win", 10))))
    team_names = [form.get(f"team_{i}", "").strip() or f"Team {i+1}" for i in range(num_teams)]

    bl = _ensure_bluf(session)
    bl.update({
        "num_teams": num_teams, "points_to_win": points_to_win,
        "team_names": team_names, "scores": [0] * num_teams,
        "current_statement": None, "current_idx": None,
        "round_number": 0, "revealed": False, "votes": {},
        "winner": None, "used_indices": set(), "history": [],
    })
    session["game"] = "bluf"
    return response


@app.get("/bluf/play", response_class=HTMLResponse)
async def bluf_play(request: Request):
    response = templates.TemplateResponse(request, "bluf_play.html", {"app_name": APP_NAME})
    sid = _ensure_session(request, response)
    if "bluf_game" not in SESSION_STORE[sid]:
        return RedirectResponse("/bluf", status_code=303)
    return response


@app.get("/bluf/state")
async def bluf_state(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    bl = _ensure_bluf(SESSION_STORE[sid])
    result: dict[str, Any] = {
        "num_teams": bl["num_teams"], "points_to_win": bl["points_to_win"],
        "team_names": bl["team_names"], "scores": bl["scores"],
        "round_number": bl["round_number"], "revealed": bl["revealed"],
        "votes": bl["votes"], "winner": bl["winner"],
    }
    if bl["current_statement"]:
        result["statement"] = bl["current_statement"]["statement"]
        if bl["revealed"]:
            result["answer"] = bl["current_statement"]["answer"]
            result["explanation"] = bl["current_statement"].get("explanation", "")
    return JSONResponse(result)


@app.post("/bluf/next")
async def bluf_next(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    bl = _ensure_bluf(SESSION_STORE[sid])
    if bl["winner"]:
        return JSONResponse({"error": "Het spel is afgelopen."}, status_code=400)

    used = bl.get("used_indices", set())
    available = [i for i in range(len(BLUF_STATEMENTS)) if i not in used]
    if not available:
        bl["used_indices"] = set()
        available = list(range(len(BLUF_STATEMENTS)))

    idx = random.choice(available)
    bl["used_indices"].add(idx)
    stmt = BLUF_STATEMENTS[idx]
    bl["current_statement"] = stmt
    bl["current_idx"] = idx
    bl["revealed"] = False
    bl["votes"] = {}
    bl["round_number"] += 1

    return JSONResponse({"statement": stmt["statement"], "round_number": bl["round_number"]})


@app.post("/bluf/vote")
async def bluf_vote(request: Request):
    form = await request.form()
    response = Response()
    sid = _ensure_session(request, response)
    bl = _ensure_bluf(SESSION_STORE[sid])

    if bl["revealed"]:
        return JSONResponse({"error": "Antwoord is al onthuld."}, status_code=400)

    team_idx = str(form.get("team", "0"))
    vote = form.get("vote", "")
    if vote not in ("true", "false"):
        return JSONResponse({"error": "Ongeldige stem."}, status_code=400)

    bl["votes"][team_idx] = vote == "true"
    return JSONResponse({"votes": {k: v for k, v in bl["votes"].items()}, "team_names": bl["team_names"]})


@app.post("/bluf/reveal")
async def bluf_reveal(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    bl = _ensure_bluf(SESSION_STORE[sid])

    if not bl["current_statement"]:
        return JSONResponse({"error": "Geen huidige stelling."}, status_code=400)

    bl["revealed"] = True
    answer = bl["current_statement"]["answer"]

    # Award points
    for team_str, vote in bl["votes"].items():
        team_idx = int(team_str)
        if 0 <= team_idx < bl["num_teams"] and vote == answer:
            bl["scores"][team_idx] += 1

    # Check winner
    winner = None
    for i, score in enumerate(bl["scores"]):
        if score >= bl["points_to_win"]:
            winner = bl["team_names"][i]
            bl["winner"] = winner
            break

    bl["history"].append({"round": bl["round_number"], "answer": answer, "votes": dict(bl["votes"])})

    return JSONResponse({
        "answer": answer,
        "explanation": bl["current_statement"].get("explanation", ""),
        "scores": bl["scores"], "team_names": bl["team_names"],
        "winner": winner,
    })


# ---------------------------------------------------------------------------
# Schattingen routes
# ---------------------------------------------------------------------------

def _ensure_schattingen(session: dict) -> dict:
    if "schattingen_game" not in session:
        session["schattingen_game"] = {
            "num_teams": 2, "points_to_win": 10,
            "team_names": ["Team 1", "Team 2"],
            "scores": [0, 0],
            "current_question": None, "current_idx": None,
            "round_number": 0, "revealed": False,
            "guesses": {},
            "winner": None, "used_indices": set(), "history": [],
        }
    return session["schattingen_game"]


@app.get("/schat/setup", response_class=HTMLResponse)
async def schat_setup(request: Request):
    response = templates.TemplateResponse(request, "schat_setup.html", {"app_name": APP_NAME})
    _ensure_session(request, response)
    return response


@app.post("/schat/start")
async def schat_start(request: Request):
    form = await request.form()
    response = RedirectResponse("/schat/play", status_code=303)
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]

    num_teams = min(max(int(form.get("num_teams", 2)), 2), 6)
    points_to_win = max(3, min(30, int(form.get("points_to_win", 10))))
    team_names = [form.get(f"team_{i}", "").strip() or f"Team {i+1}" for i in range(num_teams)]

    sc = _ensure_schattingen(session)
    sc.update({
        "num_teams": num_teams, "points_to_win": points_to_win,
        "team_names": team_names, "scores": [0] * num_teams,
        "current_question": None, "current_idx": None,
        "round_number": 0, "revealed": False, "guesses": {},
        "winner": None, "used_indices": set(), "history": [],
    })
    session["game"] = "schattingen"
    return response


@app.get("/schat/play", response_class=HTMLResponse)
async def schat_play(request: Request):
    response = templates.TemplateResponse(request, "schat_play.html", {"app_name": APP_NAME})
    sid = _ensure_session(request, response)
    if "schattingen_game" not in SESSION_STORE[sid]:
        return RedirectResponse("/schattingen", status_code=303)
    return response


@app.get("/schat/state")
async def schat_state(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    sc = _ensure_schattingen(SESSION_STORE[sid])
    result: dict[str, Any] = {
        "num_teams": sc["num_teams"], "points_to_win": sc["points_to_win"],
        "team_names": sc["team_names"], "scores": sc["scores"],
        "round_number": sc["round_number"], "revealed": sc["revealed"],
        "guesses": sc["guesses"], "winner": sc["winner"],
    }
    if sc["current_question"]:
        result["question"] = sc["current_question"]["question"]
        if sc["revealed"]:
            result["answer"] = sc["current_question"]["answer"]
    return JSONResponse(result)


@app.post("/schat/next")
async def schat_next(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    sc = _ensure_schattingen(SESSION_STORE[sid])
    if sc["winner"]:
        return JSONResponse({"error": "Het spel is afgelopen."}, status_code=400)

    used = sc.get("used_indices", set())
    available = [i for i in range(len(SCHATTINGEN_QUESTIONS)) if i not in used]
    if not available:
        sc["used_indices"] = set()
        available = list(range(len(SCHATTINGEN_QUESTIONS)))

    idx = random.choice(available)
    sc["used_indices"].add(idx)
    q = SCHATTINGEN_QUESTIONS[idx]
    sc["current_question"] = q
    sc["current_idx"] = idx
    sc["revealed"] = False
    sc["guesses"] = {}
    sc["round_number"] += 1

    return JSONResponse({"question": q["question"], "round_number": sc["round_number"]})


@app.post("/schat/guess")
async def schat_guess(request: Request):
    form = await request.form()
    response = Response()
    sid = _ensure_session(request, response)
    sc = _ensure_schattingen(SESSION_STORE[sid])

    if sc["revealed"]:
        return JSONResponse({"error": "Antwoord is al onthuld."}, status_code=400)

    team_idx = str(form.get("team", "0"))
    try:
        guess_val = float(str(form.get("guess", "0")).replace(",", "."))
    except ValueError:
        return JSONResponse({"error": "Ongeldig getal."}, status_code=400)

    sc["guesses"][team_idx] = guess_val
    return JSONResponse({"guesses": sc["guesses"], "team_names": sc["team_names"]})


@app.post("/schat/reveal")
async def schat_reveal(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    sc = _ensure_schattingen(SESSION_STORE[sid])

    if not sc["current_question"]:
        return JSONResponse({"error": "Geen huidige vraag."}, status_code=400)

    sc["revealed"] = True
    answer = sc["current_question"]["answer"]

    # Find closest team(s)
    if sc["guesses"]:
        distances = {}
        for team_str, guess in sc["guesses"].items():
            distances[team_str] = abs(guess - answer)
        min_dist = min(distances.values())
        winners = [t for t, d in distances.items() if d == min_dist]

        for t in winners:
            ti = int(t)
            if 0 <= ti < sc["num_teams"]:
                sc["scores"][ti] += 1

    # Check winner
    winner = None
    for i, score in enumerate(sc["scores"]):
        if score >= sc["points_to_win"]:
            winner = sc["team_names"][i]
            sc["winner"] = winner
            break

    sc["history"].append({"round": sc["round_number"], "answer": answer, "guesses": dict(sc["guesses"])})

    return JSONResponse({
        "answer": answer,
        "guesses": sc["guesses"],
        "scores": sc["scores"], "team_names": sc["team_names"],
        "winner": winner,
    })


    sc["history"].append({"round": sc["round_number"], "answer": answer, "guesses": dict(sc["guesses"])})

    return JSONResponse({
        "answer": answer,
        "guesses": sc["guesses"],
        "scores": sc["scores"], "team_names": sc["team_names"],
        "winner": winner,
    })


# ---------------------------------------------------------------------------
# Emoji Quiz routes
# ---------------------------------------------------------------------------

@app.get("/emoji/play", response_class=HTMLResponse)
async def emoji_play(request: Request):
    response = templates.TemplateResponse(request, "emoji_play.html", {"app_name": APP_NAME})
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    if "emoji_game" not in session:
        indices = list(range(len(EMOJI_QUIZ_ITEMS)))
        random.shuffle(indices)
        session["emoji_game"] = {"order": indices, "current_idx": -1}
    session["game"] = "emoji-quiz"
    return response


@app.post("/emoji/next")
async def emoji_next(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    eq = session.get("emoji_game")
    if not eq:
        return JSONResponse({"error": "Geen spel actief."}, status_code=400)
    eq["current_idx"] += 1
    if eq["current_idx"] >= len(eq["order"]):
        return Response(status_code=204)
    item = EMOJI_QUIZ_ITEMS[eq["order"][eq["current_idx"]]]
    return JSONResponse({
        "emoji": item["emoji"],
        "category": item.get("category", ""),
        "number": eq["current_idx"] + 1,
        "total": len(eq["order"]),
    })


@app.post("/emoji/reveal")
async def emoji_reveal(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    eq = session.get("emoji_game")
    if not eq or eq["current_idx"] < 0 or eq["current_idx"] >= len(eq["order"]):
        return JSONResponse({"error": "Geen actieve vraag."}, status_code=400)
    item = EMOJI_QUIZ_ITEMS[eq["order"][eq["current_idx"]]]
    return JSONResponse({"answer": item["answer"], "category": item.get("category", "")})


@app.post("/emoji/reset")
async def emoji_reset(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    indices = list(range(len(EMOJI_QUIZ_ITEMS)))
    random.shuffle(indices)
    session["emoji_game"] = {"order": indices, "current_idx": -1}
    return JSONResponse({"status": "ok"})


# ---------------------------------------------------------------------------
# Ranking routes
# ---------------------------------------------------------------------------

def _ensure_ranking(session: dict) -> dict:
    if "ranking_game" not in session:
        session["ranking_game"] = {
            "num_teams": 2, "points_to_win": 10,
            "team_names": ["Team 1", "Team 2"],
            "scores": [0, 0],
            "current_question": None, "current_idx": None,
            "shuffled_items": [],
            "round_number": 0, "revealed": False,
            "winner": None, "used_indices": set(), "history": [],
        }
    return session["ranking_game"]


@app.get("/ranking/setup", response_class=HTMLResponse)
async def ranking_setup(request: Request):
    response = templates.TemplateResponse(request, "ranking_setup.html", {"app_name": APP_NAME})
    _ensure_session(request, response)
    return response


@app.post("/ranking/start")
async def ranking_start(request: Request):
    form = await request.form()
    response = RedirectResponse("/ranking/play", status_code=303)
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]

    num_teams = min(max(int(form.get("num_teams", 2)), 2), 6)
    points_to_win = max(3, min(30, int(form.get("points_to_win", 10))))
    team_names = [form.get(f"team_{i}", "").strip() or f"Team {i+1}" for i in range(num_teams)]

    rk = _ensure_ranking(session)
    rk.update({
        "num_teams": num_teams, "points_to_win": points_to_win,
        "team_names": team_names, "scores": [0] * num_teams,
        "current_question": None, "current_idx": None,
        "shuffled_items": [],
        "round_number": 0, "revealed": False,
        "winner": None, "used_indices": set(), "history": [],
    })
    session["game"] = "ranking"
    return response


@app.get("/ranking/play", response_class=HTMLResponse)
async def ranking_play(request: Request):
    response = templates.TemplateResponse(request, "ranking_play.html", {"app_name": APP_NAME})
    sid = _ensure_session(request, response)
    if "ranking_game" not in SESSION_STORE[sid]:
        return RedirectResponse("/ranking", status_code=303)
    return response


@app.get("/ranking/state")
async def ranking_state(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    rk = _ensure_ranking(SESSION_STORE[sid])
    result: dict[str, Any] = {
        "num_teams": rk["num_teams"], "points_to_win": rk["points_to_win"],
        "team_names": rk["team_names"], "scores": rk["scores"],
        "round_number": rk["round_number"], "revealed": rk["revealed"],
        "winner": rk["winner"],
    }
    if rk["current_question"]:
        result["question"] = rk["current_question"]["question"]
        result["items"] = rk["shuffled_items"]
        if rk["revealed"]:
            result["correct_order"] = [item["name"] for item in sorted(rk["current_question"]["items"], key=lambda x: x["rank"])]
    return JSONResponse(result)


@app.post("/ranking/next")
async def ranking_next(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    rk = _ensure_ranking(SESSION_STORE[sid])
    if rk["winner"]:
        return JSONResponse({"error": "Het spel is afgelopen."}, status_code=400)

    used = rk.get("used_indices", set())
    available = [i for i in range(len(RANKING_QUESTIONS)) if i not in used]
    if not available:
        rk["used_indices"] = set()
        available = list(range(len(RANKING_QUESTIONS)))

    idx = random.choice(available)
    rk["used_indices"].add(idx)
    q = RANKING_QUESTIONS[idx]
    rk["current_question"] = q
    rk["current_idx"] = idx
    rk["revealed"] = False
    rk["round_number"] += 1

    # Shuffle items for display
    shuffled = [item["name"] for item in q["items"]]
    random.shuffle(shuffled)
    rk["shuffled_items"] = shuffled

    return JSONResponse({
        "question": q["question"],
        "items": shuffled,
        "round_number": rk["round_number"],
    })


@app.post("/ranking/reveal")
async def ranking_reveal(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    rk = _ensure_ranking(SESSION_STORE[sid])

    if not rk["current_question"]:
        return JSONResponse({"error": "Geen huidige vraag."}, status_code=400)

    rk["revealed"] = True
    correct = [item["name"] for item in sorted(rk["current_question"]["items"], key=lambda x: x["rank"])]

    return JSONResponse({
        "correct_order": correct,
        "scores": rk["scores"], "team_names": rk["team_names"],
        "winner": rk["winner"],
    })


@app.post("/ranking/award")
async def ranking_award(request: Request):
    """Host awards a point to the team that got the ranking closest."""
    form = await request.form()
    response = Response()
    sid = _ensure_session(request, response)
    rk = _ensure_ranking(SESSION_STORE[sid])

    team_idx = int(form.get("team", 0))
    if 0 <= team_idx < rk["num_teams"]:
        rk["scores"][team_idx] += 1

    # Check winner
    winner = None
    for i, score in enumerate(rk["scores"]):
        if score >= rk["points_to_win"]:
            winner = rk["team_names"][i]
            rk["winner"] = winner
            break

    return JSONResponse({
        "scores": rk["scores"], "team_names": rk["team_names"],
        "winner": winner,
    })


# ---------------------------------------------------------------------------
# Categories routes
# ---------------------------------------------------------------------------

@app.get("/cat/play", response_class=HTMLResponse)
async def cat_play(request: Request):
    response = templates.TemplateResponse(request, "cat_play.html", {"app_name": APP_NAME})
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    if "cat_game" not in session:
        indices = list(range(len(CATEGORIES_CARDS)))
        random.shuffle(indices)
        session["cat_game"] = {"order": indices, "current_idx": -1}
    session["game"] = "categories"
    return response


@app.post("/cat/next")
async def cat_next(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    cat = session.get("cat_game")
    if not cat:
        return JSONResponse({"error": "Geen spel actief."}, status_code=400)
    cat["current_idx"] += 1
    if cat["current_idx"] >= len(cat["order"]):
        return Response(status_code=204)
    card = CATEGORIES_CARDS[cat["order"][cat["current_idx"]]]
    return JSONResponse({
        "category": card["category"],
        "letter": card["letter"],
        "number": cat["current_idx"] + 1,
        "total": len(cat["order"]),
    })


@app.post("/cat/reset")
async def cat_reset(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]
    indices = list(range(len(CATEGORIES_CARDS)))
    random.shuffle(indices)
    session["cat_game"] = {"order": indices, "current_idx": -1}
    return JSONResponse({"status": "ok"})


# ---------------------------------------------------------------------------
# Timeline routes
# ---------------------------------------------------------------------------

def _ensure_timeline(session: dict) -> dict:
    if "timeline_game" not in session:
        session["timeline_game"] = {
            "num_teams": 2, "points_to_win": 10,
            "team_names": ["Team 1", "Team 2"],
            "scores": [0, 0],
            "current_event": None, "current_idx": None,
            "round_number": 0, "revealed": False,
            "guesses": {},
            "winner": None, "used_indices": set(), "history": [],
        }
    return session["timeline_game"]


@app.get("/tl/setup", response_class=HTMLResponse)
async def tl_setup(request: Request):
    response = templates.TemplateResponse(request, "tl_setup.html", {"app_name": APP_NAME})
    _ensure_session(request, response)
    return response


@app.post("/tl/start")
async def tl_start(request: Request):
    form = await request.form()
    response = RedirectResponse("/tl/play", status_code=303)
    sid = _ensure_session(request, response)
    session = SESSION_STORE[sid]

    num_teams = min(max(int(form.get("num_teams", 2)), 2), 6)
    points_to_win = max(3, min(30, int(form.get("points_to_win", 10))))
    team_names = [form.get(f"team_{i}", "").strip() or f"Team {i+1}" for i in range(num_teams)]

    tl = _ensure_timeline(session)
    tl.update({
        "num_teams": num_teams, "points_to_win": points_to_win,
        "team_names": team_names, "scores": [0] * num_teams,
        "current_event": None, "current_idx": None,
        "round_number": 0, "revealed": False, "guesses": {},
        "winner": None, "used_indices": set(), "history": [],
    })
    session["game"] = "timeline"
    return response


@app.get("/tl/play", response_class=HTMLResponse)
async def tl_play(request: Request):
    response = templates.TemplateResponse(request, "tl_play.html", {"app_name": APP_NAME})
    sid = _ensure_session(request, response)
    if "timeline_game" not in SESSION_STORE[sid]:
        return RedirectResponse("/timeline", status_code=303)
    return response


@app.get("/tl/state")
async def tl_state(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    tl = _ensure_timeline(SESSION_STORE[sid])
    result: dict[str, Any] = {
        "num_teams": tl["num_teams"], "points_to_win": tl["points_to_win"],
        "team_names": tl["team_names"], "scores": tl["scores"],
        "round_number": tl["round_number"], "revealed": tl["revealed"],
        "guesses": tl["guesses"], "winner": tl["winner"],
    }
    if tl["current_event"]:
        result["event"] = tl["current_event"]["event"]
        if tl["revealed"]:
            result["year"] = tl["current_event"]["year"]
    return JSONResponse(result)


@app.post("/tl/next")
async def tl_next(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    tl = _ensure_timeline(SESSION_STORE[sid])
    if tl["winner"]:
        return JSONResponse({"error": "Het spel is afgelopen."}, status_code=400)

    used = tl.get("used_indices", set())
    available = [i for i in range(len(TIMELINE_EVENTS)) if i not in used]
    if not available:
        tl["used_indices"] = set()
        available = list(range(len(TIMELINE_EVENTS)))

    idx = random.choice(available)
    tl["used_indices"].add(idx)
    ev = TIMELINE_EVENTS[idx]
    tl["current_event"] = ev
    tl["current_idx"] = idx
    tl["revealed"] = False
    tl["guesses"] = {}
    tl["round_number"] += 1

    return JSONResponse({"event": ev["event"], "round_number": tl["round_number"]})


@app.post("/tl/guess")
async def tl_guess(request: Request):
    form = await request.form()
    response = Response()
    sid = _ensure_session(request, response)
    tl = _ensure_timeline(SESSION_STORE[sid])

    if tl["revealed"]:
        return JSONResponse({"error": "Antwoord is al onthuld."}, status_code=400)

    team_idx = str(form.get("team", "0"))
    try:
        guess_val = int(str(form.get("guess", "0")).replace(",", ".").split(".")[0])
    except ValueError:
        return JSONResponse({"error": "Ongeldig jaar."}, status_code=400)

    tl["guesses"][team_idx] = guess_val
    return JSONResponse({"guesses": tl["guesses"], "team_names": tl["team_names"]})


@app.post("/tl/reveal")
async def tl_reveal(request: Request):
    response = Response()
    sid = _ensure_session(request, response)
    tl = _ensure_timeline(SESSION_STORE[sid])

    if not tl["current_event"]:
        return JSONResponse({"error": "Geen huidig evenement."}, status_code=400)

    tl["revealed"] = True
    year = tl["current_event"]["year"]

    # Find closest team(s)
    if tl["guesses"]:
        distances = {}
        for team_str, guess in tl["guesses"].items():
            distances[team_str] = abs(guess - year)
        min_dist = min(distances.values())
        winners = [t for t, d in distances.items() if d == min_dist]

        for t in winners:
            ti = int(t)
            if 0 <= ti < tl["num_teams"]:
                tl["scores"][ti] += 1

    # Check winner
    winner = None
    for i, score in enumerate(tl["scores"]):
        if score >= tl["points_to_win"]:
            winner = tl["team_names"][i]
            tl["winner"] = winner
            break

    tl["history"].append({"round": tl["round_number"], "year": year, "guesses": dict(tl["guesses"])})

    return JSONResponse({
        "year": year,
        "guesses": tl["guesses"],
        "scores": tl["scores"], "team_names": tl["team_names"],
        "winner": winner,
    })


# ---------------------------------------------------------------------------
# Runner (Dino game) – purely client-side, just serve the page
# ---------------------------------------------------------------------------

@app.get("/runner/play", response_class=HTMLResponse)
async def runner_play(request: Request):
    response = templates.TemplateResponse(request, "runner_play.html", {"app_name": APP_NAME})
    _ensure_session(request, response)
    return response


# ---------------------------------------------------------------------------
# Arena – purely client-side, just serve the page
# ---------------------------------------------------------------------------

@app.get("/arena/play", response_class=HTMLResponse)
async def arena_play(request: Request):
    response = templates.TemplateResponse(request, "arena_play.html", {"app_name": APP_NAME})
    _ensure_session(request, response)
    return response


@app.get("/{game}", response_class=HTMLResponse)
async def index(request: Request, game: str):
    """Category selection for a specific game."""
    if game not in VALID_GAMES:
        return RedirectResponse("/", status_code=303)

    # Games that go directly to setup / play (no category selection)
    if game == "thirty-seconds":
        return RedirectResponse("/ts/setup", status_code=303)
    if game == "taboe":
        return RedirectResponse("/taboe/setup", status_code=303)
    if game == "wie-ben-ik":
        return RedirectResponse("/wbi/setup", status_code=303)
    if game == "muziekbingo":
        return RedirectResponse("/mbingo/setup", status_code=303)
    if game == "dit-of-dat":
        return RedirectResponse("/dod/play", status_code=303)
    if game == "bluf":
        return RedirectResponse("/bluf/setup", status_code=303)
    if game == "schattingen":
        return RedirectResponse("/schat/setup", status_code=303)
    if game == "emoji-quiz":
        return RedirectResponse("/emoji/play", status_code=303)
    if game == "ranking":
        return RedirectResponse("/ranking/setup", status_code=303)
    if game == "categories":
        return RedirectResponse("/cat/play", status_code=303)
    if game == "timeline":
        return RedirectResponse("/tl/setup", status_code=303)
    if game == "runner":
        return RedirectResponse("/runner/play", status_code=303)
    if game == "arena":
        return RedirectResponse("/arena/play", status_code=303)

    if game == "guess-the-year":
        cats = GTY_SONGS
        meta = {
            name: {"label": GTY_ORIGIN_LABELS.get(name, name.replace("_", " ").title())}
            for name in cats
        }
        response = templates.TemplateResponse(
            request,
            "index.html",
            {
                "categories": {name: len(items) for name, items in cats.items()},
                "category_meta": meta,
                "app_name": APP_NAME,
                "game": game,
                "game_label": GAME_LABELS[game],
            },
        )
        _ensure_session(request, response)
        return response

    cats = GAME_DATA[game]
    meta = GAME_META.get(game, {})
    response = templates.TemplateResponse(
        request,
        "index.html",
        {
            "categories": {name: len(items) for name, items in cats.items()},
            "category_meta": meta,
            "app_name": APP_NAME,
            "game": game,
            "game_label": GAME_LABELS[game],
        },
    )
    _ensure_session(request, response)
    return response
