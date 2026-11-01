// The GoXLR's gate and compressor times/ratios. GoXLR Utility declares these four as #[repr(u8)]
// enums with serde_repr, so the engine sends and expects the position in these lists (0, 1, 2 …),
// not the names – before 0.4.8 the app sent the names ("invalid type: string "Gate10ms", expected
// u8"). The order must match goxlr-types (types/src/lib.rs, tag v1.2.4).
export const GATE_TIMES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900, 950, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000].map((t) => `Gate${t}ms`);
export const RATIOS = ['Ratio1_0', 'Ratio1_1', 'Ratio1_2', 'Ratio1_4', 'Ratio1_6', 'Ratio1_8', 'Ratio2_0', 'Ratio2_5', 'Ratio3_2', 'Ratio4_0', 'Ratio5_6', 'Ratio8_0', 'Ratio16_0', 'Ratio32_0', 'Ratio64_0'];
export const ATTACKS = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 23, 26, 30, 35, 40].map((t) => `Comp${t}ms`);
export const RELEASES = [0, 15, 25, 35, 45, 55, 65, 75, 85, 100, 115, 140, 170, 230, 340, 680, 1000, 1500, 2000, 3000].map((t) => `Comp${t}ms`);

/** Position in `list` of a value from the engine (a number) or a name ("Gate10ms"); 0 if unknown. */
export function enumIndex(list, v) {
  if (typeof v === 'number' && Number.isInteger(v)) return Math.max(0, Math.min(list.length - 1, v));
  const i = list.indexOf(v);
  return i < 0 ? 0 : i;
}
