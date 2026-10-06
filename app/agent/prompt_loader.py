from pathlib import Path

from app.core.config import get_settings
from app.runtime.platform import is_windows


PROMPT_DIR = Path(__file__).parent / "prompts"


def _platform_prompt_name(name: str) -> str | None:
    try:
        settings = get_settings()
        shell_provider = settings.shell_provider.strip().lower()
    except Exception:
        shell_provider = ""

    if shell_provider in {"powershell", "pwsh"} or (shell_provider in {"", "auto"} and is_windows()):
        path = Path(name)
        suffix = path.suffix or ".md"
        return f"{path.stem}.windows{suffix}"
    return None


def load_prompt(name: str) -> str:
    """
    加载节点级 prompt 模板。

    约定：
    - name 为 prompts 目录下的文件名
    - 使用 UTF-8 编码
    """
    platform_name = _platform_prompt_name(name)
    if platform_name:
        platform_path = PROMPT_DIR / platform_name
        if platform_path.exists():
            return platform_path.read_text(encoding="utf-8")

    path = PROMPT_DIR / name
    return path.read_text(encoding="utf-8")
