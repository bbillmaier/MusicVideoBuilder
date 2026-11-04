export type DanceStyle = {
  name: string;
  feel: string;
  moves: string[];
  dynamics: string;
};

// Keep these names and movement vocabularies aligned with MartiniShot/dance_styles.json.
export const DANCE_STYLES: DanceStyle[] = [
  { name: "Commercial Hip-Hop", feel: "Confident, polished, and charismatic.", moves: ["sharp footwork", "grounded bounce", "shoulder pops", "chest hits", "arm swings", "body rolls", "quick turns", "brief freezes"], dynamics: "Smooth groove alternates with explosive accents." },
  { name: "Old-School Hip-Hop", feel: "Playful, loose, and full of swagger.", moves: ["running man", "Roger Rabbit", "kick-ball-change", "wop", "Biz Markie step", "head nods", "side-to-side bounce"], dynamics: "A relaxed, bouncy groove with occasional big hits." },
  { name: "K-Pop", feel: "Precise, bright, and camera-aware.", moves: ["sharp arm formations", "hip sways", "point moves", "quick level changes", "hair flips", "stepping slides", "clean poses on accents"], dynamics: "Tight, exact movement that snaps into poses on accents." },
  { name: "Jazz-Funk", feel: "Fierce, sensual, and theatrical.", moves: ["hip isolations", "sharp head snaps", "hair whips", "slow body waves", "strong walks", "chest isolations", "dramatic poses"], dynamics: "Controlled sensual movement contrasts with sudden sharp hits." },
  { name: "R&B Groove", feel: "Smooth, relaxed, and effortlessly cool.", moves: ["two-step", "body waves", "slow hip rolls", "shoulder rolls", "subtle bounce", "smooth slides", "laid-back arm gestures"], dynamics: "A continuous, fluid groove with soft accents." },
  { name: "House", feel: "Joyful, light, and driven by a four-on-the-floor pulse.", moves: ["jacking torso pulse", "loose-leg shuffles", "heel-toe footwork", "skates", "quick spins", "lofting floor touches"], dynamics: "Fast, light footwork builds in complexity." },
  { name: "Breaking", feel: "Athletic, competitive, and bold.", moves: ["toprock", "go-downs", "six-step footwork", "coffee grinders", "chair freezes", "baby freezes", "power transitions"], dynamics: "Standing toprock builds into floor work and decisive freezes." },
  { name: "Afrobeats", feel: "Joyful, grounded, and rhythmically relaxed.", moves: ["azonto arm gestures", "shoki shoulder bounce", "legwork footwork", "hip whines", "zanku steps", "grounded knee bends"], dynamics: "Loose, grounded rhythm with polyrhythmic hip and shoulder accents." },
  { name: "Contemporary", feel: "Emotional, expressive, and flowing.", moves: ["sweeping arm extensions", "spirals", "floor releases", "suspended balances", "contractions", "fluid turns", "reaching gestures"], dynamics: "Breath-driven movement with suspended moments and controlled releases." },
  { name: "Latin / Reggaeton", feel: "Sensual, rhythmic, and celebratory.", moves: ["perreo hip movement", "dembow bounce", "Cuban motion", "body waves", "quick hip accents", "playful turns"], dynamics: "A steady dembow rhythm with sharp accents and playful variation." },
];

export function danceStyleByName(name: string): DanceStyle | undefined {
  return DANCE_STYLES.find((style) => style.name === name);
}
