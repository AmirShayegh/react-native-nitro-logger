/** See ./measure.d.ts for why these declarations exist at all. */
export const CONTROL: string;
export const MULTIPLE: number;
export function checkControlFloor(
  results: { name: string; nsPerOp: number }[]
): string[];
