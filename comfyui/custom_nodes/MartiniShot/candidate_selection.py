"""Opt-in, inspectable selection among LLM-proposed action candidates."""

from __future__ import annotations

import random
import re
from typing import Any

from .location_evidence import evidence_text


SYSTEM_PROMPT = """You turn existing music-video story beats into alternatives. For every section, output one CONTRACT
line followed by exactly three CANDIDATE lines. Each candidate must repeat the literal contract ID supplied for that
section. The action remains creative. Its evidence field lists exact supplied location-evidence terms it relies on, or
none. Do not claim unknown space is unavailable. Output only the requested lines."""


def build_message(story: dict[int, dict[str, str]], refs: list[dict[str, Any]]) -> str:
    locations = {ref["name"]: evidence_text(ref.get("location_evidence")) for ref in refs if ref["kind"] == "Location"}
    lines = ["Create action candidates for these existing story beats. Preserve each beat's narrative purpose and any "
             "declared Story Wheel turn/end state."]
    for number, beat in story.items():
        location = beat.get("location") or "the selected location"
        lines.append(f"SECTION {number} | contract ID: S{number} | story: {beat.get('beat', '')} | turn: {beat.get('turn', '') or 'none'} "
                     f"| ends: {beat.get('ends', '') or 'none'} | location: {location} | "
                     f"evidence: {locations.get(location, 'none')}")
    lines.append(
        "Format exactly:\n"
        "SECTION <n> | CONTRACT: S<n>\n"
        "CANDIDATE <n>.1 | contract: S<n> | action: <one concrete sentence> | outcome: <repeat the required end state, or none> | evidence: <exact evidence terms, comma-separated, or none> | posture: <short label>\n"
        "CANDIDATE <n>.2 | contract: S<n> | action: <one concrete sentence> | outcome: <repeat the required end state, or none> | evidence: <exact evidence terms, comma-separated, or none> | posture: <short label>\n"
        "CANDIDATE <n>.3 | contract: S<n> | action: <one concrete sentence> | outcome: <repeat the required end state, or none> | evidence: <exact evidence terms, comma-separated, or none> | posture: <short label>"
    )
    return "\n".join(lines)


def _fields(line: str) -> dict[str, str]:
    return {key.lower(): " ".join(value.split())[:160] for key, value in
            re.findall(r"\b(contract|action|outcome|evidence|posture):\s*([^|]+)", line, re.IGNORECASE)}


def parse_candidates(text: str, count: int) -> dict[int, dict[str, Any]]:
    result = {number: {"contract": "", "candidates": []} for number in range(1, count + 1)}
    for line in text.splitlines():
        contract = re.match(r"\s*SECTION\s+(\d+)\s*\|\s*CONTRACT:\s*(S\d+)\s*$", line, re.IGNORECASE)
        candidate = re.match(r"\s*CANDIDATE\s+(\d+)\.(\d+)\s*\|", line, re.IGNORECASE)
        if contract and int(contract.group(1)) in result:
            result[int(contract.group(1))]["contract"] = contract.group(2).upper()
        elif candidate and int(candidate.group(1)) in result:
            fields = _fields(line)
            if fields.get("action"):
                result[int(candidate.group(1))]["candidates"].append(fields)
    return result


def _same(left: str, right: str) -> bool:
    clean = lambda text: re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return clean(left) == clean(right)


def choose_candidates(parsed: dict[int, dict[str, Any]], refs: list[dict[str, Any]], seed: int,
                      story: dict[int, dict[str, str]]) -> tuple[dict[int, dict[str, str]], list[str]]:
    evidence = {ref["name"]: ref.get("location_evidence") or {} for ref in refs if ref["kind"] == "Location"}
    rng, selected, report = random.Random(seed), {}, []
    recent: list[dict[str, str]] = []
    for number, entry in parsed.items():
        contract, candidates = entry["contract"] or f"S{number}", entry["candidates"]
        if len(candidates) < 2:
            report.append(f"  section {number}: no usable candidate set; keeping the original story action.")
            continue
        place_evidence = evidence.get(story.get(number, {}).get("location", ""), {})
        scored = []
        for candidate in candidates:
            reasons, score = [], 0
            if not _same(candidate.get("contract", ""), contract):
                report.append(f"  section {number}: reject '{candidate['action']}' (contract must be {contract})")
                continue
            required_outcome = story.get(number, {}).get("ends", "")
            if required_outcome and not _same(candidate.get("outcome", ""), required_outcome):
                report.append(f"  section {number}: reject '{candidate['action']}' (outcome must preserve Story Wheel end state)")
                continue
            evidence_terms = [term.strip() for term in candidate.get("evidence", "").split(",") if term.strip()]
            if evidence_terms and evidence_terms != ["none"]:
                if any(any(_same(term, item) for item in place_evidence.get("contradicted", ())) for term in evidence_terms):
                    report.append(f"  section {number}: reject '{candidate['action']}' (contradicted evidence)")
                    continue
                if any(any(_same(term, item) for item in place_evidence.get("supported", ())) for term in evidence_terms):
                    score += 2
                    reasons.append("supported evidence +2")
                elif any(any(_same(term, item) for item in place_evidence.get("unknown", ())) for term in evidence_terms):
                    score -= 1
                    reasons.append("unknown evidence -1")
            repeats = sum(_same(candidate.get("posture", ""), prior.get("posture", "")) or
                          _same(candidate.get("evidence", ""), prior.get("evidence", "")) for prior in recent[-2:])
            if repeats:
                score -= repeats
                reasons.append(f"recent repetition -{repeats}")
            scored.append((score, candidate, reasons))
        if not scored:
            report.append(f"  section {number}: no candidate survived; keeping the original story action.")
            continue
        best = max(score for score, _, _ in scored)
        winners = [(candidate, reasons) for score, candidate, reasons in scored if score == best]
        candidate, reasons = rng.choice(winners)
        selected[number] = candidate
        recent.append(candidate)
        report.append(f"  section {number}: contract={contract}")
        for score, option, notes in scored:
            report.append(f"    score {score:+d}: {option['action']}" + (f" ({', '.join(notes)})" if notes else ""))
        report.append(f"    selected: {candidate['action']}")
    return selected, report
