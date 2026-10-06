"""An optional reader failure must not prevent the desktop app starting."""
import os
from app.plugins.qq_reader import QQReader, QQReaderConfig

async def start_qq_reader(app):
    app.state.qq_reader = None
    try:
        reader = QQReader(config=QQReaderConfig.from_env())
        app.state.qq_reader = reader
        await reader.start()
    except Exception:
        if app.state.qq_reader:
            await app.state.qq_reader.stop()
        app.state.qq_reader = None
        app.state.qq_reader_status = {
            "enabled": os.getenv("QQ_READER_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"},
            "connection_state": "stopped", "last_error": "configuration_error",
        }

async def stop_qq_reader(app):
    if app.state.qq_reader:
        await app.state.qq_reader.stop()


async def start_qq_messaging(app):
    from app.plugins.qq_messaging import QQMessaging
    app.state.qq_messaging = None
    try:
        service = QQMessaging()
        app.state.qq_messaging = service
        await service.start()
    except Exception:
        service = app.state.qq_messaging
        if service:
            await service.stop()
            service.ready = False
            service.last_error = "configuration_error"


async def stop_qq_messaging(app):
    service = getattr(app.state, "qq_messaging", None)
    if service:
        await service.stop()
