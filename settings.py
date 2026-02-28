"""Application settings for Party Games webapp."""

import os
import secrets

APP_NAME = "Party Games"

# Session signing secret: use env var or generate a stable one per process
SESSION_SECRET: str = os.environ.get("HINTS_SESSION_SECRET", secrets.token_hex(32))

# Session time-to-live: 8 hours of inactivity
SESSION_TTL_SECONDS: int = 8 * 3600

# Rate limiting: max requests to /next per minute per session
RATE_LIMIT_PER_MIN: int = 10

# Paths to word list JSON files (data/ lives at project root, same level as app.py)
_DATA_DIR: str = os.path.join(os.path.dirname(__file__), "data", "lijsten")
HINTS_DATA_PATH: str = os.path.join(_DATA_DIR, "hints.json")
PICTIONARY_DATA_PATH: str = os.path.join(_DATA_DIR, "pictionary.json")
THIRTY_SECONDS_DATA_PATH: str = os.path.join(_DATA_DIR, "thirty_seconds.json")
TABOE_DATA_PATH: str = os.path.join(_DATA_DIR, "taboe.json")
WIE_BEN_IK_DATA_PATH: str = os.path.join(_DATA_DIR, "wie_ben_ik.json")
DIT_OF_DAT_DATA_PATH: str = os.path.join(_DATA_DIR, "dit_of_dat.json")
BLUF_DATA_PATH: str = os.path.join(_DATA_DIR, "bluf.json")
SCHATTINGEN_DATA_PATH: str = os.path.join(_DATA_DIR, "schattingen.json")
EMOJI_QUIZ_DATA_PATH: str = os.path.join(_DATA_DIR, "emoji_quiz.json")
RANKING_DATA_PATH: str = os.path.join(_DATA_DIR, "ranking.json")
CATEGORIES_DATA_PATH: str = os.path.join(_DATA_DIR, "categories.json")
TIMELINE_DATA_PATH: str = os.path.join(_DATA_DIR, "timeline.json")

# Paths to Guess the Year data
_GTY_DIR: str = os.path.join(os.path.dirname(__file__), "data", "guess-the-year-data")
GTY_DATA_PATH: str = os.path.join(_GTY_DIR, "centralized", "unique_per_list.csv")
GTY_QR_DIR: str = os.path.join(_GTY_DIR, "qrcodes", "spotify")
