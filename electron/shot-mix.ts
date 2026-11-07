// The Direction shot mix, shared by the main process and the renderer (no Node imports).
import { TIMELINE_SCENES, type CreativeDirection, type TimelineScene } from "./contracts";

export type ShotWeights = Pick<CreativeDirection, "danceWeight" | "performanceWeight" | "freeformWeight" | "brollWeight">;

export const SCENE_WEIGHT_KEY: Record<TimelineScene, keyof ShotWeights> = {
  Dance: "danceWeight", Performance: "performanceWeight", Freeform: "freeformWeight", "B-roll": "brollWeight",
};

/** The chance of each scene type for a section whose role has these ticks (none = every type). Same rules as Martini
 *  Shot's shot_mix.section_pool: ticks restrict the pool; ticked types share equally when all their weights are 0;
 *  with nothing ticked and every weight 0, sections dance. */
export function sceneChances(weights: ShotWeights, ticked?: readonly TimelineScene[]): { scene: TimelineScene; chance: number }[] {
  const weightOf = (scene: TimelineScene) => Math.max(0, weights[SCENE_WEIGHT_KEY[scene]]);
  const pool = TIMELINE_SCENES.filter((scene) => !ticked?.length || ticked.includes(scene));
  const total = pool.reduce((sum, scene) => sum + weightOf(scene), 0);
  if (total <= 0) return ticked?.length ? pool.map((scene) => ({ scene, chance: 1 / pool.length })) : [{ scene: "Dance", chance: 1 }];
  return pool.filter((scene) => weightOf(scene) > 0).map((scene) => ({ scene, chance: weightOf(scene) / total }));
}

/** "Dance 60% · Performance 40%" */
export function chancesText(chances: { scene: TimelineScene; chance: number }[]): string {
  return chances.map(({ scene, chance }) => `${scene} ${Math.round(chance * 100)}%`).join(" · ");
}
