from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, HTTPException
from langchain_core.messages import HumanMessage, SystemMessage

from app.agent.llm import get_chat_model
from app.runtime.conversation_store import get_conversation_store

from app.runtime.shell_runtime import (
    get_pending_shell_approval,
    list_pending_shell_approvals,
    reject_shell_approval,
    run_shell_command,
)

router = APIRouter(prefix="/shell", tags=["shell"])


def _summarize_execution_fallback(command: str, exit_code: int) -> str:
    command_text = command.strip()
    if exit_code == 0:
        if command_text:
            return f"好的，已经为你执行完成。命令：`{command_text}`。"
        return "好的，已经为你执行完成。"
    if command_text:
        return f"我已执行命令，但结果未成功（exit_code={exit_code}）。命令：`{command_text}`。"
    return f"我已执行命令，但结果未成功（exit_code={exit_code}）。"


def _build_approval_assistant_message(
    *,
    conversation_id: str | None,
    command: str,
    exit_code: int,
    stdout: str,
    stderr: str,
) -> str:
    command_text = command.strip()
    if not command_text:
        return _summarize_execution_fallback(command, exit_code)

    last_user_request = ""
    try:
        if (conversation_id or "").strip():
            context = get_conversation_store().load_context_bundle(str(conversation_id), "")
            for item in reversed(context.messages):
                if str(item.get("role", "")).strip() == "user":
                    last_user_request = str(item.get("content", "")).strip()
                    if last_user_request:
                        break
    except Exception:
        last_user_request = ""

    prompt_messages = [
        SystemMessage(
            content=(
                "你是一个执行助手。你会在 shell 命令执行后给用户一个自然、简短、可信的中文回复。"
                "要求：\n"
                "1) 必须明确说明是否执行成功。\n"
                "2) 必须包含执行的命令（用反引号包裹）。\n"
                "3) 若失败，给出一个下一步建议或需要的补充信息。\n"
                "4) 控制在 1-3 句。"
            )
        ),
        HumanMessage(
            content=(
                f"用户上一条请求：{last_user_request or '(unknown)'}\n"
                f"执行命令：{command_text}\n"
                f"exit_code：{exit_code}\n"
                f"stdout（截断）：{(stdout or '').strip()[:800]}\n"
                f"stderr（截断）：{(stderr or '').strip()[:800]}"
            )
        ),
    ]
    try:
        response = get_chat_model().invoke(prompt_messages)
        content = str(getattr(response, "content", "")).strip()
        if content:
            return content
    except Exception:
        pass
    return _summarize_execution_fallback(command_text, exit_code)


@router.get("/approvals")
async def list_shell_approvals() -> dict[str, object]:
    return {"approvals": list_pending_shell_approvals()}


@router.get("/approvals/{approval_id}")
async def get_shell_approval(approval_id: str) -> dict[str, object]:
    approval = get_pending_shell_approval(approval_id)
    if approval is None:
        raise HTTPException(status_code=404, detail="shell approval not found or expired")
    return approval


@router.post("/approvals/{approval_id}/approve")
async def approve_shell_approval(approval_id: str) -> dict[str, object]:
    approval = get_pending_shell_approval(approval_id)
    if approval is None:
        raise HTTPException(status_code=404, detail="shell approval not found or expired")

    result = run_shell_command(
        str(approval["command"]),
        cwd=str(approval["cwd"]),
        conversation_id=str(approval.get("conversation_id", "")).strip() or None,
        approval_id=approval_id,
    )
    assistant_message = _build_approval_assistant_message(
        conversation_id=str(approval.get("conversation_id", "")).strip() or None,
        command=result.command,
        exit_code=result.exit_code,
        stdout=result.stdout,
        stderr=result.stderr,
    )
    return {"approval": approval, "result": asdict(result), "assistant_message": assistant_message}


@router.post("/approvals/{approval_id}/reject")
async def reject_shell_approval_endpoint(approval_id: str) -> dict[str, object]:
    rejected = reject_shell_approval(approval_id)
    if not rejected:
        raise HTTPException(status_code=404, detail="shell approval not found or expired")
    return {"approval_id": approval_id, "rejected": True}
