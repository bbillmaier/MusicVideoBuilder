"""Align known song lyrics to Whisper word timestamps and slice them per segment.

Pure logic only; the Whisper call lives in the node. Lyrics use the common AI-music
layout: section tags such as [Verse] or [Chorus] on their own lines, one lyric
line per line.
"""

from __future__ import annotations

import difflib
import re
from typing import Any

try:
    from .h3_prompt import format_cut_time
except ImportError:  # imported as a top-level module by the tests
    from h3_prompt import format_cut_time


_TAG = re.compile(r"^\s*\[([^\]]+)\]\s*$")
_WORD = re.compile(r"[a-z0-9']+")
SECONDS_PER_UNMATCHED_WORD = 0.3


def normalize(word: str) -> str:
    return "".join(_WORD.findall(word.lower().replace("’", "'"))).strip("'")


def parse_lyrics(text: str) -> list[dict[str, Any]]:
    """Returns lyric lines: {"section", "text", "words"} in sung order."""
    lines = []
    section = "Verse"
    for raw in str(text or "").splitlines():
        tag = _TAG.match(raw)
        if tag:
            section = tag.group(1).strip()
            continue
        line = raw.strip()
        words = [word for word in line.split() if normalize(word)]
        if words:
            lines.append({"section": section, "text": line, "words": words})
    return lines


def is_chorus(section: str) -> bool:
    name = section.lower()
    return "chorus" in name and not name.startswith("pre")


def align_lyrics(lines: list[dict[str, Any]], transcript: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Give every lyric word a time.

    transcript: Whisper words [{"word", "start", "end"}]. Matched words take
    Whisper's time; unmatched words are interpolated between their matched
    neighbours. Returns timed words {"text", "start", "end", "line", "section",
    "matched"} and warnings.
    """
    words = [
        {"text": word, "line": index, "section": line["section"], "matched": False}
        for index, line in enumerate(lines)
        for word in line["words"]
    ]
    heard = [(normalize(w["word"]), float(w["start"]), float(w["end"])) for w in transcript if normalize(w["word"])]
    matcher = difflib.SequenceMatcher(
        None, [normalize(w["text"]) for w in words], [h[0] for h in heard], autojunk=False
    )
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            word = words[block.a + offset]
            _, start, end = heard[block.b + offset]
            word.update(start=start, end=end, matched=True)

    matched = [i for i, w in enumerate(words) if w["matched"]]
    warnings = []
    if not matched:
        return [], ["WARNING: No lyric words matched the transcription; lyrics were not used."]
    for index, word in enumerate(words):
        if word["matched"]:
            continue
        before = max((i for i in matched if i < index), default=None)
        after = min((i for i in matched if i > index), default=None)
        if before is not None and after is not None:
            span = words[after]["start"] - words[before]["end"]
            fraction = (index - before) / (after - before)
            word["start"] = words[before]["end"] + span * fraction
        elif before is not None:
            word["start"] = words[before]["end"] + SECONDS_PER_UNMATCHED_WORD * (index - before - 1)
        else:
            word["start"] = max(0.0, words[after]["start"] - SECONDS_PER_UNMATCHED_WORD * (after - index))
        word["end"] = word["start"] + SECONDS_PER_UNMATCHED_WORD

    ratio = len(matched) / len(words)
    if ratio < 0.5:
        warnings.append(f"WARNING: Only {ratio:.0%} of lyric words were heard; lyric timing is rough.")
    weak = [
        index + 1 for index, line in enumerate(lines)
        if not any(w["matched"] for w in words if w["line"] == index)
    ]
    if weak:
        warnings.append(
            f"NOTE: {len(weak)} lyric line(s) were not heard at all (lines {', '.join(map(str, weak[:10]))}"
            f"{'...' if len(weak) > 10 else ''}); they are left out of lip-sync."
        )
    for line_index in weak:
        for word in words:
            if word["line"] == line_index:
                word["unheard"] = True
    return words, warnings


def words_from_transcript(whisper_segments: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Use Whisper's own transcription as the lyrics (no section tags). Returns (timed words, lines)."""
    words, lines = [], []
    for segment in whisper_segments:
        heard = [w for w in segment.get("words", []) if normalize(w["word"])]
        if not heard:
            continue
        index = len(lines)
        lines.append({"section": "Vocals", "text": " ".join(w["word"].strip() for w in heard), "words": []})
        for word in heard:
            text = word["word"].strip()
            lines[index]["words"].append(text)
            words.append({
                "text": text, "start": float(word["start"]), "end": float(word["end"]),
                "line": index, "section": "Vocals", "matched": True,
            })
    return words, lines


def segment_phrases(words: list[dict[str, Any]], start: float, end: float) -> list[dict[str, Any]]:
    """Consecutive words of one lyric line inside [start, end), with times relative to the segment."""
    phrases: list[dict[str, Any]] = []
    for word in words:
        if not start <= word["start"] < end:
            continue
        if phrases and phrases[-1]["line"] == word["line"]:
            phrases[-1]["words"].append(word["text"])
            phrases[-1]["unheard"] = phrases[-1]["unheard"] and word.get("unheard", False)
            continue
        phrases.append({
            "line": word["line"],
            "section": word["section"],
            "start": word["start"] - start,
            "words": [word["text"]],
            "unheard": word.get("unheard", False),
        })
    for phrase in phrases:
        phrase["text"] = " ".join(phrase["words"])
    return phrases


def segment_sections(words: list[dict[str, Any]], start: float, end: float) -> list[str]:
    """Song sections playing during [start, end): sections with words inside, or the one still running."""
    inside = []
    for word in words:
        if start <= word["start"] < end and word["section"] not in inside:
            inside.append(word["section"])
    if inside:
        return inside
    earlier = [word for word in words if word["start"] < start]
    later = [word for word in words if word["start"] >= end]
    if not earlier:
        return ["Intro (instrumental)"]
    if not later:
        return ["Outro (instrumental)"]
    return [f"{earlier[-1]['section']} (instrumental)"]


def format_lyrics_for_llm(phrases: list[dict[str, Any]], sections: list[str]) -> str:
    lines = [f"Song section(s) during this segment: {', '.join(sections)}."]
    if phrases:
        lines.append("Lyrics sung during this segment (times from the segment start):")
        lines += [f"- {format_cut_time(p['start'])} [{p['section']}] {p['text']}" for p in phrases]
    else:
        lines.append("No lyrics are sung during this segment.")
    return "\n".join(lines)


def lip_sync_paragraph(phrases: list[dict[str, Any]], language: str) -> str:
    sung = [phrase for phrase in phrases if not phrase["unheard"]]
    if not sung:
        return ""
    parts = [
        f"At {format_cut_time(p['start'])}, <d>[{language}] {p['text']}</d>" for p in sung
    ]
    return (
        "Throughout the dance, <Subject 1> sings along with the vocals of <Audio 1>, lip-syncing each "
        "lyric line in time with the music: " + "; ".join(parts) + "."
    )


def format_lyrics_timing(words: list[dict[str, Any]], lines: list[dict[str, Any]]) -> str:
    rows = []
    for index, line in enumerate(lines):
        line_words = [w for w in words if w["line"] == index]
        if not line_words:
            continue
        heard = sum(w["matched"] for w in line_words)
        rows.append(
            f"{format_cut_time(line_words[0]['start'])} [{line['section']}] {line['text']} "
            f"({heard}/{len(line_words)} words heard)"
        )
    return "\n".join(rows)
