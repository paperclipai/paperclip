from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .config import get_settings
from .db import init_db, SessionLocal
from .services.seed import seed_if_empty
from .services.orchestrator import ensure_default_agents
from .services.integrations import ensure_integrations
from .services.workflows import ensure_workflow_templates
from .services.capabilities import ensure_tool_capabilities
from .services.autonomy import ensure_autonomy_defaults
from .services.enchantments import ensure_enchantments
from .services.v5 import ensure_v5_defaults
from .scheduler import start_scheduler, stop_scheduler
from .routers import (
    health,
    chat,
    ceo,
    companies,
    employees,
    tasks,
    intelligence,
    agents,
    governance,
    dashboard,
    temporal,
    risk,
    content,
    integrations,
    providers,
    mission_control,
    federation,
    capabilities,
    autonomy,
    enchantments,
    v5,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    db = SessionLocal()
    try:
        seed_if_empty(db)
        ensure_default_agents(db)
        ensure_integrations(db)
        ensure_workflow_templates(db)
        ensure_tool_capabilities(db)
        ensure_autonomy_defaults(db)
        ensure_enchantments(db)
        ensure_v5_defaults(db)
    finally:
        db.close()
    start_scheduler()
    yield
    await stop_scheduler()

settings = get_settings()
app = FastAPI(title=settings.app_name, version="5.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(chat.router)
app.include_router(ceo.router)
app.include_router(companies.router)
app.include_router(employees.router)
app.include_router(tasks.router)
app.include_router(intelligence.router)
app.include_router(agents.router)
app.include_router(governance.router)
app.include_router(dashboard.router)
app.include_router(temporal.router)
app.include_router(risk.router)
app.include_router(content.router)
app.include_router(integrations.router)
app.include_router(providers.router)

app.include_router(mission_control.router)
app.include_router(federation.router)
app.include_router(capabilities.router)
app.include_router(autonomy.router)
app.include_router(enchantments.router)
app.include_router(v5.router)
