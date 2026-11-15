import os

def get_settings():
    return {
        "database_url": os.environ["DATABASE_URL"],
        "smtp_password": os.getenv("SMTP_PASSWORD"),
        "legacy": os.environ.get("LEGACY_API_ENDPOINT"),
        "feature_x": os.getenv("ENABLE_FEATURE_X"),
    }
