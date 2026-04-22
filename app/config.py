"""Application configuration."""

import os

from dotenv import load_dotenv

load_dotenv()


class Settings:
    """Runtime settings loaded from environment variables."""

    CRCON_URL = os.getenv("CRCON_URL", "http://localhost:8010")
    CRCON_TOKEN = os.getenv("CRCON_TOKEN", "")
    DATABASE_URL = os.getenv(
        "DATABASE_URL",
        "postgresql://postgres:postgres@localhost:5432/mapvote_service",
    )
    VOTE_WORKER_INTERVAL_SECONDS = int(os.getenv("VOTE_WORKER_INTERVAL_SECONDS", "5"))


settings = Settings()
