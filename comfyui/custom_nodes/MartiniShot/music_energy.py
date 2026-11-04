"""Song-relative RMS loudness shared by section, clip and phrase planning."""

import numpy as np


def rms_level(waveform: np.ndarray) -> float:
    mono = np.asarray(waveform, dtype=np.float32)
    if mono.ndim > 1:
        mono = mono.mean(axis=0)
    return float(np.sqrt(np.mean(mono * mono))) if mono.size else 0.0


def energy_reference(waveform: np.ndarray, sample_rate: int) -> tuple[float, float]:
    """10th/90th percentile dB of one-second windows; independent of shot boundaries."""
    mono = np.asarray(waveform, dtype=np.float32)
    if mono.ndim > 1:
        mono = mono.mean(axis=0)
    levels = [rms_level(mono[i:i + sample_rate]) for i in range(0, len(mono), sample_rate)]
    db = 20 * np.log10(np.maximum(levels or [0.0], 1e-6))
    low, high = np.percentile(db, [10, 90])
    return float(low), float(high)


def relative_energy(level: float, reference: tuple[float, float]) -> float:
    low, high = reference
    # Less than 2 dB of song-wide variation is treated as steady, not exaggerated.
    if high - low < 2.0:
        return 0.5
    db = 20 * np.log10(max(level, 1e-6))
    return float(np.clip((db - low) / (high - low), 0.0, 1.0))


def energy_label(value: float) -> str:
    return "high" if value > 2 / 3 else "medium" if value > 1 / 3 else "low"
