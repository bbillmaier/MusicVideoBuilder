from .dance_nodes import MiniMaxH3PromptLLMLoader
from .mv_auto_nodes import MiniMaxH3AutoReference
from .live_preview import MartiniShotLivePreview
from .file_api import register_file_api
from .nodes import NODE_CLASS_MAPPINGS as _STAGED_NODES, NODE_DISPLAY_NAME_MAPPINGS as _STAGED_NAMES
from .video_nodes import MiniMaxH3TrimOverlap
from .postprocess_nodes import (
    NODE_CLASS_MAPPINGS as _POSTPROCESS_NODES, NODE_DISPLAY_NAME_MAPPINGS as _POSTPROCESS_NAMES, register_postprocess_api,
)

NODE_CLASS_MAPPINGS = {
    **_STAGED_NODES,
    **_POSTPROCESS_NODES,
    "MiniMaxH3AutoReference": MiniMaxH3AutoReference,
    "MiniMaxH3PromptLLMLoader": MiniMaxH3PromptLLMLoader,
    "MiniMaxH3TrimOverlap": MiniMaxH3TrimOverlap,
    "MartiniShotLivePreview": MartiniShotLivePreview,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    **_STAGED_NAMES,
    **_POSTPROCESS_NAMES,
    "MiniMaxH3AutoReference": "Martini Shot Auto Director Reference",
    "MiniMaxH3PromptLLMLoader": "Martini Shot Prompt LLM Loader",
    "MiniMaxH3TrimOverlap": "Martini Shot Trim Overlap Frames",
    "MartiniShotLivePreview": "Martini Shot Live Render Preview",
}

register_file_api()
register_postprocess_api()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
