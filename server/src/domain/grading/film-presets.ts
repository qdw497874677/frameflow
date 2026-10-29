/**
 * 光谱胶片风格的预设：每卷负片一套「招牌」调校，让几卷片在同一张相纸上也拉得开差别。
 *
 * 这些数值**不是**厂商数据，是 FrameFlow 的调校假设（见 engine/PROVENANCE.md「预设」一节）：
 * 只动引擎公开的渲染参数（曝光、DIR 层间抑制强度、印放中灰、杂散光），色彩本身仍全部来自数据表。
 * - neutral：引擎缺省，所有片同一套参数，最「数据表」；
 * - signature：按各片的用途调（人像片偏亮偏柔、反转风格的 Vivid 加饱和、Gold 偏暖偏亮、黑白加反差）；
 * - soft：低反差褪色感（更高杂散光 + 略过曝）。
 */
import type { FilmParams } from './film.ts';

export const FILM_PRESETS = ['signature', 'neutral', 'soft'] as const;
export type FilmPreset = (typeof FILM_PRESETS)[number];

export const FILM_PRESET_LABELS: Record<FilmPreset, { label: string; hint: string }> = {
  signature: { label: '招牌', hint: '按每卷片的用途单独调校（FrameFlow 假设，非厂商数据）' },
  neutral: { label: '数据表', hint: '引擎缺省参数，各片同一套' },
  soft: { label: '柔和', hint: '低反差、略过曝的褪色感' },
};

/** 招牌调校（按引擎负片 id）；没列出的片 = neutral */
const SIGNATURE: Record<string, FilmParams> = {
  portrait160: { exposureEv: 0.5, dirStrength: 0.8, printGrey: 0.2 },
  portrait400: { exposureEv: 0.33, dirStrength: 1.0 },
  portrait800: { exposureEv: 0.33, dirStrength: 1.1, cameraFlare: 0.02, sceneKelvin: 5000 },
  vivid100: { exposureEv: -0.17, dirStrength: 1.6, printGrey: 0.16 },
  golden200: { exposureEv: 0.33, dirStrength: 1.3, sceneKelvin: 4800 },
  classicbw400: { exposureEv: 0, printGrey: 0.15 },
};

const SOFT: FilmParams = { exposureEv: 0.67, dirStrength: 0.7, cameraFlare: 0.04, printGrey: 0.21 };

/** 预设 + 用户曝光补偿 → 引擎渲染参数（曝光补偿叠加在预设的曝光上，截到引擎范围） */
export function filmRenderParams(stockId: string, preset: FilmPreset, exposureEv = 0): FilmParams {
  const base = preset === 'signature' ? SIGNATURE[stockId] ?? {} : preset === 'soft' ? SOFT : {};
  const ev = Math.max(-6, Math.min(6, (base.exposureEv ?? 0) + exposureEv));
  const out: Record<string, number | boolean> = { ...base };
  if (ev !== 0) out['exposureEv'] = Math.round(ev * 1000) / 1000;
  else delete out['exposureEv'];
  return out as FilmParams;
}
