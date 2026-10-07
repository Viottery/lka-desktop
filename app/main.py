from contextlib import asynccontextmanager
import asyncio
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.agent.services.local_rag_socket_service import get_local_rag_socket_service
from app.api.routes.chat import router as chat_router
from app.api.routes.health import router as health_router
from app.api.routes.pet import router as pet_router
from app.api.routes.workbench_proxy import router as workbench_router
from app.api.routes.plugins import router as plugins_router
from app.api.routes.shell import router as shell_router
from app.core.config import get_settings
from app.runtime.conversation_store import get_conversation_store
from app.plugins.lifecycle import start_qq_reader, stop_qq_reader, start_qq_messaging, stop_qq_messaging


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await asyncio.to_thread(get_conversation_store().initialize)
    settings = get_settings()
    rag_service = None
    if settings.local_rag_enabled:
        rag_service = get_local_rag_socket_service()
        await rag_service.start()
    await start_qq_reader(_app)
    await start_qq_messaging(_app)
    try:
        yield
    finally:
        await stop_qq_messaging(_app)
        await stop_qq_reader(_app)
        if rag_service is not None:
            await rag_service.stop()


app = FastAPI(title="Agentic RAG", debug=True, lifespan=lifespan)
PET_WEB_DIR = Path(__file__).parent / "web" / "pet"

app.include_router(health_router)
app.include_router(chat_router)
app.include_router(shell_router)
app.include_router(pet_router)
app.include_router(workbench_router)
app.include_router(plugins_router)
app.mount("/desktop-pet", StaticFiles(directory=PET_WEB_DIR, html=True), name="desktop-pet")


@app.get("/")
async def root() -> RedirectResponse:
    return RedirectResponse(url="/desktop-pet/")
