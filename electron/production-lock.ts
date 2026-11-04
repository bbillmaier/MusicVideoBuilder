// One production activity at a time across the whole app (writing a prompt package, a render queue, or the final stitch).
// Claimed synchronously before any await, so repeated clicks or racing IPC calls cannot start two loops.
export type ProductionBusy = { kind: "package" | "render" | "stitch"; projectId: string };

let busy: ProductionBusy | null = null;

export function productionBusy(): ProductionBusy | null {
  return busy;
}

const BUSY_TEXT: Record<ProductionBusy["kind"], string> = {
  render: "Clips are already rendering. Wait for the queue to finish, or use Stop after current clip.",
  package: "A prompt package is being written. Wait for it to finish.",
  stitch: "The final video is being stitched. Wait for it to finish.",
};

export function claimProduction(kind: ProductionBusy["kind"], projectId: string): () => void {
  if (busy) throw new Error(BUSY_TEXT[busy.kind]);
  const claim: ProductionBusy = { kind, projectId };
  busy = claim;
  return () => { if (busy === claim) busy = null; };
}
