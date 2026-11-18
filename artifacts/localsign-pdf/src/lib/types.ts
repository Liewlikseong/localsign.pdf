export type OverlayKind = 'text' | 'signature' | 'image';

/**
 * Element geometry is stored as a fraction of the visible PDF page, so it
 * remains aligned when the page is rendered at a different device scale.
 */
export interface Overlay {
  id: string;
  pageNumber: number;
  kind: OverlayKind;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  color?: string;
  /** PDF points, independent of the current canvas zoom. */
  fontSize?: number;
  /** PNG or JPEG data URL. Signature ink is stored as a transparent PNG. */
  dataUrl?: string;
  /** 0–1; used for image stamps and watermark opacity. */
  opacity?: number;
}

export interface RenderedPage {
  width: number;
  height: number;
  /** CSS pixels per PDF point for converting text controls to screen size. */
  scale: number;
}
