from fastapi import APIRouter, Depends
from ..schemas import ChatRequest, ChatResponse
from ..security import require_api_key
from ..services.llm import JarvisLLM

router = APIRouter(prefix="/chat", tags=["chat"])


@router.post("", response_model=ChatResponse, dependencies=[Depends(require_api_key)])
async def chat(req: ChatRequest):
    llm = JarvisLLM()
    reply = await llm.chat(req.message, req.context, req.personality_level)
    suggestions = ["Generate morning briefing", "Simulate decision", "Review workload", "Create board pack"]
    return ChatResponse(reply=reply, mode="llm_or_deterministic", suggested_actions=suggestions)
