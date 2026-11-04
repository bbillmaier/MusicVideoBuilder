from .dance_nodes import MiniMaxH3PromptLLMLoader
from .mv_auto_nodes import MiniMaxH3AutoReference
from .live_preview import MartiniShotLivePreview
from .nodes import NODE_CLASS_MAPPINGS as _STAGED_NODES, NODE_DISPLAY_NAME_MAPPINGS as _STAGED_NAMES
from .video_nodes import MiniMaxH3TrimOverlap

NODE_CLASS_MAPPINGS = {
    **_STAGED_NODES,
    "MiniMaxH3AutoReference": MiniMaxH3AutoReference,
    "MiniMaxH3PromptLLMLoader": MiniMaxH3PromptLLMLoader,
    "MiniMaxH3TrimOverlap": MiniMaxH3TrimOverlap,
    "MartiniShotLivePreview": MartiniShotLivePreview,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    **_STAGED_NAMES,
    "MiniMaxH3AutoReference": "Martini Shot Auto Director Reference",
    "MiniMaxH3PromptLLMLoader": "Martini Shot Prompt LLM Loader",
    "MiniMaxH3TrimOverlap": "Martini Shot Trim Overlap Frames",
    "MartiniShotLivePreview": "Martini Shot Live Render Preview",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
