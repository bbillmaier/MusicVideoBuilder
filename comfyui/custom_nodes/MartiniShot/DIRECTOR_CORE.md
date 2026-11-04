# Martini Shot director core

Martini Shot owns the local copies of the Auto Director modules it uses for story planning, location evidence, prompt writing, segment loading, and final stitching. Its staged nodes in `nodes.py` import only these local modules.

`MiniMaxPrompBuilder` remains a separate compatibility pack for existing ComfyUI workflows. Do not add Martini Shot runtime imports from that pack.

Martini Shot's planning and location-evidence caches are intentionally separate under `user/default/MartiniShot/`.
