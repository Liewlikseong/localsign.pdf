import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocument, PDFFont } from 'pdf-lib';
import type { Overlay, RenderedPage } from './types';

type PdfJsModule = typeof import('pdfjs-dist');
type PdfLoadingTask = ReturnType<PdfJsModule['getDocument']>;

const MAX_PAGE_WIDTH = 880;
const MAX_RENDER_SCALE = 1.45;
const CHINESE_OR_NON_LATIN = /[^\u0000-\u00ff]/u;
const loadingTasks = new WeakMap<
  PDFDocumentProxy,
  PdfLoadingTask
>();
const renderTasks = new WeakMap<HTMLCanvasElement, { cancel: () => void }>();
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

function getPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import('pdfjs-dist').then((module) => {
      module.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return module;
    });
  }
  return pdfJsModulePromise;
}

export async function loadPdfFile(
  file: File,
): Promise<{ document: PDFDocumentProxy; bytes: Uint8Array }> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Choose a PDF file to open.');
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdfJs = await getPdfJs();
  const loadingTask = pdfJs.getDocument({ data: bytes.slice() });
  try {
    const document = await loadingTask.promise;
    loadingTasks.set(document, loadingTask);
    return { document, bytes };
  } catch (error) {
    await loadingTask.destroy();
    throw error;
  }
}

export async function releasePdfDocument(
  document: PDFDocumentProxy | null | undefined,
): Promise<void> {
  if (!document) return;
  const loadingTask = loadingTasks.get(document);
  loadingTasks.delete(document);
  if (loadingTask) {
    await loadingTask.destroy();
  } else {
    await document.cleanup();
  }
}

export async function renderPdfPage(
  document: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
): Promise<RenderedPage> {
  await getPdfJs();
  const page = await document.getPage(pageNumber);
  const unitViewport = page.getViewport({ scale: 1 });
  const parentWidth = canvas.parentElement?.clientWidth;
  const availableWidth = Math.max(
    220,
    Math.min(
      MAX_PAGE_WIDTH,
      parentWidth || window.innerWidth - 48,
    ),
  );
  const scale = Math.min(MAX_RENDER_SCALE, availableWidth / unitViewport.width);
  const viewport = page.getViewport({ scale });
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const context = canvas.getContext('2d', { alpha: false });

  if (!context) {
    throw new Error('Your browser could not create a PDF rendering surface.');
  }

  canvas.width = Math.ceil(viewport.width * pixelRatio);
  canvas.height = Math.ceil(viewport.height * pixelRatio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, viewport.width, viewport.height);

  renderTasks.get(canvas)?.cancel();
  const renderTask = page.render({ canvasContext: context, viewport, canvas });
  renderTasks.set(canvas, renderTask);
  try {
    await renderTask.promise;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'RenderingCancelledException') {
      throw error;
    }
  } finally {
    if (renderTasks.get(canvas) === renderTask) renderTasks.delete(canvas);
  }
  return { width: viewport.width, height: viewport.height, scale };
}

export async function exportPdf(
  sourceBytes: Uint8Array,
  overlays: Overlay[],
): Promise<Uint8Array> {
  const [pdfJs, pdfLib, fontkitModule] = await Promise.all([
    getPdfJs(),
    import('pdf-lib'),
    import('@pdf-lib/fontkit'),
  ]);
  const { PDFDocument, degrees, rgb, StandardFonts } = pdfLib;
  const fontkit = fontkitModule.default;
  const pdf = await PDFDocument.load(sourceBytes.slice());
  const renderingTask = pdfJs.getDocument({ data: sourceBytes.slice() });
  const renderingDocument = await renderingTask.promise;
  const fontBytes = await loadCustomFont();
  pdf.registerFontkit(fontkit);

  const font = fontBytes
    ? await pdf.embedFont(fontBytes, { subset: true })
    : await pdf.embedFont(StandardFonts.Helvetica);

  try {
    for (const overlay of overlays) {
      const page = pdf.getPage(overlay.pageNumber - 1);
      if (!page) {
        throw new Error(`Page ${overlay.pageNumber} is not available in this PDF.`);
      }

      const renderPage = await renderingDocument.getPage(overlay.pageNumber);
      const viewport = renderPage.getViewport({ scale: 1 });
      const rotation = normalizeRotation(page.getRotation().angle);
      const { width: pageWidth, height: pageHeight } = page.getSize();
      const isQuarterTurn = rotation === 90 || rotation === 270;
      const viewportWidthPoints = isQuarterTurn ? pageHeight : pageWidth;
      const viewportHeightPoints = isQuarterTurn ? pageWidth : pageHeight;
      const canvasToPdfScaleX = viewport.width / Math.max(1, viewportWidthPoints);
      const canvasToPdfScaleY = viewport.height / Math.max(1, viewportHeightPoints);
      const left = clamp01(overlay.x) * viewportWidthPoints * canvasToPdfScaleX;
      const top = clamp01(overlay.y) * viewportHeightPoints * canvasToPdfScaleY;
      const right = clamp01(overlay.x + overlay.width) * viewportWidthPoints * canvasToPdfScaleX;
      const bottom = clamp01(overlay.y + overlay.height) * viewportHeightPoints * canvasToPdfScaleY;

      const topLeft = viewport.convertToPdfPoint(left, top);
      const topRight = viewport.convertToPdfPoint(right, top);
      const bottomLeft = viewport.convertToPdfPoint(left, bottom);
      const bottomRight = viewport.convertToPdfPoint(right, bottom);
      const points = [topLeft, topRight, bottomLeft, bottomRight];
      const minX = Math.min(...points.map(([x]) => x));
      const maxX = Math.max(...points.map(([x]) => x));
      const minY = Math.min(...points.map(([, y]) => y));
      const maxY = Math.max(...points.map(([, y]) => y));
      const width = maxX - minX;
      const height = maxY - minY;
      if (overlay.kind === 'text') {
        const text = overlay.text?.trimEnd();
        if (!text) continue;

        const fontSize = Math.max(4, Math.min(256, overlay.fontSize ?? 16));
        const isQuarterTurn = rotation === 90 || rotation === 270;
        const boxWidth = Math.max(1, isQuarterTurn ? height : width);
        const boxHeight = Math.max(1, isQuarterTurn ? width : height);
        const maxLines = Math.max(1, Math.floor(boxHeight / (fontSize * 1.2)));

        if (!fontBytes && CHINESE_OR_NON_LATIN.test(text)) {
          const lines = wrapTextOnCanvas(text, fontSize, boxWidth).slice(0, maxLines);
          const textCanvas = renderTextCanvas(
            lines,
            fontSize,
            boxWidth,
            boxHeight,
            overlay.color ?? '#17251f',
          );
          const textImage = await pdf.embedPng(
            dataUrlToBytes(textCanvas.toDataURL('image/png')),
          );
          const drawWidth = isQuarterTurn ? height : width;
          const drawHeight = isQuarterTurn ? width : height;
          const fittedText = textImage.scaleToFit(drawWidth, drawHeight);
          page.drawImage(textImage, {
            x: (minX + maxX - fittedText.width) / 2,
            y: (minY + maxY - fittedText.height) / 2,
            width: fittedText.width,
            height: fittedText.height,
            rotate: degrees(-rotation),
          });
          continue;
        }

        const lines = wrapText(text, font, fontSize, boxWidth).slice(0, maxLines);
        const baselineNudge = Math.max(fontSize * 0.16, boxHeight - fontSize * 0.86);
        const verticalSpan = Math.hypot(
          topLeft[0] - bottomLeft[0],
          topLeft[1] - bottomLeft[1],
        );
        const textStartX = bottomLeft[0] + (topLeft[0] - bottomLeft[0]) *
          (baselineNudge / Math.max(1, verticalSpan));
        const textStartY = bottomLeft[1] + (topLeft[1] - bottomLeft[1]) *
          (baselineNudge / Math.max(1, verticalSpan));

        page.drawText(lines.join('\n'), {
          x: textStartX,
          y: textStartY,
          size: fontSize,
          font,
          color: rgb(...hexToRgb(overlay.color ?? '#17251f')),
          lineHeight: fontSize * 1.2,
          rotate: degrees(-rotation),
        });
      } else if (overlay.dataUrl) {
        const imageBytes = dataUrlToBytes(overlay.dataUrl);
        const embeddedImage = overlay.dataUrl.startsWith('data:image/jpeg') ||
          overlay.dataUrl.startsWith('data:image/jpg')
          ? await pdf.embedJpg(imageBytes)
          : await pdf.embedPng(imageBytes);
        const opacity = clamp01(overlay.opacity ?? 1);
        const isQuarterTurn = rotation === 90 || rotation === 270;
        const drawWidth = isQuarterTurn ? height : width;
        const drawHeight = isQuarterTurn ? width : height;
        const fittedImage = embeddedImage.scaleToFit(drawWidth, drawHeight);
        const x = (minX + maxX - fittedImage.width) / 2;
        const y = (minY + maxY - fittedImage.height) / 2;

        page.drawImage(embeddedImage, {
          x,
          y,
          width: fittedImage.width,
          height: fittedImage.height,
          opacity,
          rotate: degrees(-rotation),
        });
      }
    }

    return await pdf.save();
  } finally {
    await renderingTask.destroy();
  }
}

async function loadCustomFont(): Promise<Uint8Array | null> {
  try {
    const response = await fetch(
      `${import.meta.env.BASE_URL}fonts/NotoSansSC-Regular.ttf`,
    );
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const signature = String.fromCharCode(...bytes.slice(0, 4));
    const isTrueType =
      bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0;
    return isTrueType || ['OTTO', 'true', 'typ1'].includes(signature)
      ? bytes
      : null;
  } catch {
    return null;
  }
}

function wrapText(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): string[] {
  return text.split('\n').flatMap((paragraph) => {
    if (paragraph.length === 0) return [''];
    const wrapped: string[] = [];
    let line = '';

    for (const character of paragraph) {
      const candidate = line + character;
      if (line && font.widthOfTextAtSize(candidate, fontSize) > maxWidth) {
        wrapped.push(line);
        line = character;
      } else {
        line = candidate;
      }
    }
    wrapped.push(line);
    return wrapped;
  });
}

function wrapTextOnCanvas(
  text: string,
  fontSize: number,
  maxWidth: number,
): string[] {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return text.split('\n');
  context.font = `${fontSize}px sans-serif`;

  return text.split('\n').flatMap((paragraph) => {
    if (paragraph.length === 0) return [''];
    const wrapped: string[] = [];
    let line = '';

    for (const character of paragraph) {
      const candidate = line + character;
      if (line && context.measureText(candidate).width > maxWidth) {
        wrapped.push(line);
        line = character;
      } else {
        line = candidate;
      }
    }
    wrapped.push(line);
    return wrapped;
  });
}

function renderTextCanvas(
  lines: string[],
  fontSize: number,
  width: number,
  height: number,
  color: string,
): HTMLCanvasElement {
  const resolution = 3;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * resolution));
  canvas.height = Math.max(1, Math.ceil(height * resolution));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Your browser could not prepare the text image.');

  context.scale(resolution, resolution);
  context.font = `${fontSize}px sans-serif`;
  context.fillStyle = /^#[\da-f]{6}$/i.test(color) ? color : '#17251f';
  context.textBaseline = 'alphabetic';
  const firstBaseline = fontSize * 0.86;
  lines.forEach((line, index) => {
    context.fillText(line, 0, firstBaseline + index * fontSize * 1.2, width);
  });
  return canvas;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const separator = dataUrl.indexOf(',');
  if (separator === -1) throw new Error('The selected image is not a valid data URL.');
  const binary = atob(dataUrl.slice(separator + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[\da-f]{6}$/i.test(hex) ? hex.slice(1) : '17251f';
  return [
    Number.parseInt(normalized.slice(0, 2), 16) / 255,
    Number.parseInt(normalized.slice(2, 4), 16) / 255,
    Number.parseInt(normalized.slice(4, 6), 16) / 255,
  ];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeRotation(rotation: number): number {
  return ((rotation % 360) + 360) % 360;
}
