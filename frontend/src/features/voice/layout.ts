import { clampNumber } from '../../shared/storage';

export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 420;

export function clampSidebarWidth(value: number) {
  return clampNumber(Math.round(value), SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
}
