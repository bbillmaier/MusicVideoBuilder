import { useEffect, useState } from "react";

/** Peak bars (0–1) for the song, decoded locally in the renderer from the project's read-only asset URL. */
export function usePeaks(url: string | null, bars = 220): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    if (!url) { setPeaks(null); return; }
    let cancelled = false;
    (async () => {
      const buffer = await (await fetch(url)).arrayBuffer();
      const context = new AudioContext();
      try {
        const channel = (await context.decodeAudioData(buffer)).getChannelData(0);
        const step = Math.max(1, Math.floor(channel.length / bars));
        // sample sparsely inside long buckets; short buckets (high resolution) read every sample
        const stride = Math.max(1, Math.min(32, Math.floor(step / 64)));
        const values: number[] = [];
        for (let bar = 0; bar < bars; bar++) {
          let peak = 0;
          for (let i = bar * step; i < Math.min(channel.length, (bar + 1) * step); i += stride) peak = Math.max(peak, Math.abs(channel[i]));
          values.push(peak);
        }
        const max = Math.max(...values, 0.0001);
        if (!cancelled) setPeaks(values.map((value) => value / max));
      } finally { void context.close(); }
    })().catch(() => { if (!cancelled) setPeaks(null); });
    return () => { cancelled = true; };
  }, [url, bars]);
  return peaks;
}
