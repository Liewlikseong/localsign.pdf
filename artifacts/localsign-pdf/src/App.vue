<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import SignaturePad from 'signature_pad'
import type { Overlay } from './lib/types'
import { exportPdf, loadPdfFile, releasePdfDocument, renderPdfPage } from './lib/pdf'

const fileInput = ref<HTMLInputElement | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)
const viewerRef = ref<HTMLElement | null>(null)
const doc = shallowRef<PDFDocumentProxy | null>(null)
const originalBytes = ref<Uint8Array | null>(null)
const fileName = ref('')
const pages = ref<number[]>([])
const pageCanvases = reactive<Record<number, HTMLCanvasElement | null>>({})
const pageShells = reactive<Record<number, HTMLElement | null>>({})
const pageScales = reactive<Record<number, number>>({})
const pageDimensions = reactive<Record<number, { width: number; height: number }>>({})
const overlays = ref<Overlay[]>([])
const selectedId = ref<string | null>(null)
const currentPage = ref(1)
const activeTool = ref<'select' | 'text' | 'signature' | 'image'>('select')
const isDraggingFile = ref(false)
const isLoading = ref(false)
const isExporting = ref(false)
const errorMessage = ref('')
const signatureOpen = ref(false)
const signatureColor = ref('#000000')
const signatureCanvas = ref<HTMLCanvasElement | null>(null)
let signaturePad: SignaturePad | null = null
const hasSignatureInk = ref(false)
const faqs = ref([false, false, false, false])
const dragState = ref<{ id: string; page: number; x: number; y: number; width: number; height: number; startX: number; startY: number; mode: 'move' | 'resize'; pageRect: DOMRect } | null>(null)
const selectedOverlay = computed(() => overlays.value.find(item => item.id === selectedId.value) ?? null)
const hasDocument = computed(() => !!doc.value && pages.value.length > 0)
const statusLabel = computed(() => isLoading.value ? 'Preparing your file' : isExporting.value ? 'Creating your copy' : 'Ready when you are')
let pageObserver: IntersectionObserver | null = null
let resizeTimeout: number | undefined

function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }

async function openFile(file?: File) {
  if (!file) return
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    errorMessage.value = 'Choose a PDF file to get started.'
    return
  }
  if (file.size > 100 * 1024 * 1024) {
    errorMessage.value = 'This file is larger than 100 MB. Choose a smaller PDF to continue.'
    return
  }
  errorMessage.value = ''
  isLoading.value = true
  const previousDocument = doc.value
  doc.value = null
  originalBytes.value = null
  fileName.value = ''
  pages.value = []
  overlays.value = []
  selectedId.value = null
  currentPage.value = 1
  try {
    await releasePdfDocument(previousDocument).catch(() => undefined)
    const loaded = await loadPdfFile(file)
    doc.value = loaded.document
    originalBytes.value = loaded.bytes
    fileName.value = file.name
    pages.value = Array.from({ length: loaded.document.numPages }, (_, index) => index + 1)
    await nextTick()
    await renderAllPages()
  } catch (error) {
    doc.value = null
    pages.value = []
    errorMessage.value = error instanceof Error ? error.message : 'This PDF could not be opened. Try another file.'
  } finally {
    isLoading.value = false
  }
}

function setPageCanvas(page: number, element: Element | null) {
  pageCanvases[page] = element as HTMLCanvasElement | null
}

function setPageShell(page: number, element: Element | null) {
  pageShells[page] = element as HTMLElement | null
  if (element && pageObserver) pageObserver.observe(element)
}

async function renderOnePage(page: number) {
  const canvas = pageCanvases[page]
  if (!canvas || !doc.value) return
  try {
    const result = await renderPdfPage(doc.value, page, canvas)
    pageScales[page] = result.scale
    pageDimensions[page] = { width: result.width, height: result.height }
  } catch {
    errorMessage.value = `Page ${page} could not be rendered.`
  }
}

async function renderAllPages() {
  await Promise.all(pages.value.map(renderOnePage))
}

function onDrop(event: DragEvent) {
  isDraggingFile.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) openFile(file)
}

function addText() {
  if (!hasDocument.value) return
  const page = currentPage.value
  const item: Overlay = { id: uid(), pageNumber: page, kind: 'text', x: .11, y: .2, width: .42, height: .075, text: 'Add your text', color: '#263833', fontSize: 18 }
  overlays.value.push(item)
  selectedId.value = item.id
  activeTool.value = 'select'
}

function createSignature(dataUrl: string) {
  const item: Overlay = { id: uid(), pageNumber: currentPage.value, kind: 'signature', x: .12, y: .68, width: .27, height: .095, dataUrl, opacity: 1 }
  overlays.value.push(item)
  selectedId.value = item.id
  activeTool.value = 'select'
  signatureOpen.value = false
}

function openSignature() {
  signatureOpen.value = true
  activeTool.value = 'signature'
  hasSignatureInk.value = false
}

function clearSignature() {
  signaturePad?.clear()
  hasSignatureInk.value = false
}

function saveSignature() {
  if (!hasSignatureInk.value || !signaturePad) return
  createSignature(signaturePad.toDataURL('image/png'))
  closeSignature()
}

let signatureObserver: ResizeObserver | null = null

function resizeSignatureCanvas() {
  const canvas = signatureCanvas.value
  if (!canvas) return
  const ratio = Math.max(window.devicePixelRatio || 1, 1)
  const width = canvas.offsetWidth
  const height = canvas.offsetHeight
  if (!width || !height) return
  canvas.width = width * ratio
  canvas.height = height * ratio
  canvas.getContext('2d')?.scale(ratio, ratio)
  signaturePad?.clear()
  hasSignatureInk.value = false
}

function initializeSignaturePad() {
  const canvas = signatureCanvas.value
  if (!canvas) return
  signaturePad?.off()
  signatureObserver?.disconnect()
  resizeSignatureCanvas()
  signaturePad = new SignaturePad(canvas, {
    backgroundColor: 'rgba(0,0,0,0)',
    penColor: signatureColor.value,
    minWidth: 0.7,
    maxWidth: 2.8,
    throttle: 8,
  })
  signaturePad.addEventListener('endStroke', () => {
    hasSignatureInk.value = !signaturePad?.isEmpty()
  })
  signatureObserver = new ResizeObserver(() => resizeSignatureCanvas())
  signatureObserver.observe(canvas)
}

function closeSignature() {
  signatureOpen.value = false
  signatureObserver?.disconnect()
  signaturePad?.off()
  signaturePad = null
  activeTool.value = 'select'
}

function onPdfChoose(event: Event) {
  const input = event.target as HTMLInputElement
  void openFile(input.files?.[0])
  input.value = ''
}

function onImageChoose(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (!['image/png', 'image/jpeg'].includes(file.type)) {
    errorMessage.value = 'Choose a PNG or JPG image.'
    ;(event.target as HTMLInputElement).value = ''
    return
  }
  if (file.size > 15 * 1024 * 1024) {
    errorMessage.value = 'Images must be 15 MB or smaller.'
    ;(event.target as HTMLInputElement).value = ''
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    if (typeof reader.result !== 'string') return
    const item: Overlay = { id: uid(), pageNumber: currentPage.value, kind: 'image', x: .12, y: .24, width: .25, height: .16, dataUrl: reader.result, opacity: 1 }
    overlays.value.push(item)
    selectedId.value = item.id
    activeTool.value = 'select'
    errorMessage.value = ''
  }
  reader.onerror = () => { errorMessage.value = 'That image could not be read.' }
  reader.readAsDataURL(file)
  ;(event.target as HTMLInputElement).value = ''
}

function updateSelected(key: keyof Overlay, value: string | number) {
  if (!selectedOverlay.value) return
  ;(selectedOverlay.value as any)[key] = value
}

function deleteSelected() {
  if (!selectedId.value) return
  overlays.value = overlays.value.filter(item => item.id !== selectedId.value)
  selectedId.value = null
}

function beginOverlayPointer(event: PointerEvent, item: Overlay, mode: 'move' | 'resize') {
  if ((event.target as HTMLElement).closest('textarea,input,button')) return
  event.preventDefault()
  event.stopPropagation()
  const page = (event.currentTarget as HTMLElement).closest('[data-page-shell]') as HTMLElement | null
  if (!page) return
  const pageRect = page.getBoundingClientRect()
  selectedId.value = item.id
  dragState.value = { id: item.id, page: item.pageNumber, x: item.x, y: item.y, width: item.width, height: item.height, startX: event.clientX, startY: event.clientY, mode, pageRect }
  window.addEventListener('pointermove', onOverlayPointerMove)
  window.addEventListener('pointerup', endOverlayPointer, { once: true })
}

function onOverlayPointerMove(event: PointerEvent) {
  const state = dragState.value
  if (!state) return
  const item = overlays.value.find(entry => entry.id === state.id)
  if (!item) return
  const dx = (event.clientX - state.startX) / state.pageRect.width
  const dy = (event.clientY - state.startY) / state.pageRect.height
  if (state.mode === 'move') {
    item.x = Math.max(0, Math.min(1 - item.width, state.x + dx))
    item.y = Math.max(0, Math.min(1 - item.height, state.y + dy))
  } else {
    item.width = Math.max(.06, Math.min(1 - item.x, state.width + dx))
    item.height = Math.max(.035, Math.min(1 - item.y, state.height + dy))
  }
}

function endOverlayPointer() {
  dragState.value = null
  window.removeEventListener('pointermove', onOverlayPointerMove)
}

async function downloadPdf() {
  if (!originalBytes.value) return
  isExporting.value = true
  errorMessage.value = ''
  try {
    const output = await exportPdf(originalBytes.value, overlays.value)
    const blob = new Blob([new Uint8Array(output).buffer as ArrayBuffer], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName.value.replace(/\.pdf$/i, '') + '-signed.pdf'
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Your signed PDF could not be created. Please try again.'
  } finally {
    isExporting.value = false
  }
}

async function startOver() {
  const previousDocument = doc.value
  doc.value = null
  originalBytes.value = null
  fileName.value = ''
  pages.value = []
  currentPage.value = 1
  overlays.value = []
  selectedId.value = null
  errorMessage.value = ''
  if (fileInput.value) fileInput.value.value = ''
  await releasePdfDocument(previousDocument).catch(() => undefined)
}

function toggleFaq(index: number) { faqs.value[index] = !faqs.value[index] }

onMounted(() => {
  pageObserver = new IntersectionObserver((entries) => {
    const mostVisible = entries
      .filter(entry => entry.isIntersecting)
      .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0]
    if (mostVisible) {
      currentPage.value = Number(
        (mostVisible.target as HTMLElement).dataset.pageShell,
      )
    }
  }, { root: viewerRef.value, threshold: [0.2, 0.4, 0.6, 0.8] })
  Object.values(pageShells).forEach(element => {
    if (element) pageObserver?.observe(element)
  })
  window.addEventListener('resize', onWindowResize)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('pointermove', onOverlayPointerMove)
  window.clearTimeout(resizeTimeout)
  pageObserver?.disconnect()
  signaturePad?.off()
  void releasePdfDocument(doc.value).catch(() => undefined)
})

function onWindowResize() {
  window.clearTimeout(resizeTimeout)
  resizeTimeout = window.setTimeout(() => void renderAllPages(), 150)
}

watch(signatureOpen, async (isOpen) => {
  if (isOpen) {
    await nextTick()
    initializeSignaturePad()
  } else {
    signatureObserver?.disconnect()
    signaturePad?.off()
    signaturePad = null
  }
})

watch(signatureColor, (color) => {
  if (signaturePad) signaturePad.penColor = color
})
</script>

<template>
  <div class="min-h-[100dvh] text-[#273532]">
    <header class="sticky top-0 z-30 border-b border-[#dce2dc] bg-[#f8f9f5]/95 backdrop-blur-md">
      <div class="mx-auto flex h-[68px] max-w-[1440px] items-center justify-between px-4 sm:px-7 lg:px-10">
        <a href="#" class="flex items-center gap-3" aria-label="LocalSign PDF home" data-testid="brand-home">
          <span class="grid h-9 w-9 place-items-center rounded-[11px] bg-[#356c5b] text-[#f9faf5]">
            <svg viewBox="0 0 24 24" class="h-[21px] w-[21px]" fill="none" aria-hidden="true"><path d="M7 3.75h7l4.25 4.3v12.2H7a2 2 0 0 1-2-2v-12.5a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.6"/><path d="M14 4v4.5h4.2M8.5 13h7M8.5 16.5h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </span>
          <span class="leading-none">
            <span class="block text-[15px] font-bold tracking-[-.04em]">localsign<span class="font-medium text-[#7b8982]">.pdf</span></span>
            <span class="mt-1 block text-[9px] font-semibold uppercase tracking-[.18em] text-[#87928b]">Private by design</span>
          </span>
        </a>
        <div class="flex items-center gap-2 sm:gap-5">
          <a href="#how-it-works" class="hidden text-[13px] font-medium text-[#697872] transition hover:text-[#285344] sm:block" data-testid="nav-how">How it works</a>
          <span class="hidden h-5 w-px bg-[#dce2dc] sm:block"></span>
          <div class="flex items-center gap-2 rounded-full border border-[#d8e5da] bg-[#eff5ef] px-3 py-[7px] text-[11px] font-semibold text-[#356c5b]" aria-label="100% local and private. Files never leave your device." data-testid="privacy-badge">
            <span class="relative flex h-[7px] w-[7px]"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#79a88f] opacity-40"></span><span class="relative inline-flex h-[7px] w-[7px] rounded-full bg-[#54836c]"></span></span>
            <span class="hidden sm:inline">100% Local &amp; Private — Files Never Leave Your Device</span><span class="sm:hidden">Private</span>
          </div>
          <div v-if="hasDocument" class="hidden items-center gap-1 2xl:flex" aria-label="PDF actions">
            <button @click="addText" class="rounded-md px-2 py-2 text-[10px] font-semibold text-[#60766a] transition hover:bg-[#eef3ed] hover:text-[#315d49]" aria-label="Add text to the current page" data-testid="header-add-text">Text</button>
            <button @click="openSignature" class="rounded-md px-2 py-2 text-[10px] font-semibold text-[#60766a] transition hover:bg-[#eef3ed] hover:text-[#315d49]" aria-label="Draw a signature" data-testid="header-add-signature">Sign</button>
            <button @click="imageInput?.click()" class="rounded-md px-2 py-2 text-[10px] font-semibold text-[#60766a] transition hover:bg-[#eef3ed] hover:text-[#315d49]" aria-label="Add an image stamp" data-testid="header-add-image">Image Sign/Stamp</button>
            <button @click="downloadPdf" :disabled="isExporting" class="rounded-md bg-[#356c5b] px-2.5 py-2 text-[10px] font-semibold text-white transition hover:bg-[#285344] disabled:opacity-60" aria-label="Download the signed PDF" data-testid="header-download-pdf">Download</button>
          </div>
          <button @click="fileInput?.click()" class="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#d7e0d8] bg-[#fffefa] px-3 text-[11px] font-semibold text-[#496454] transition hover:border-[#a8bcae] hover:bg-[#f2f6f1]" aria-label="Upload a PDF from your device" data-testid="header-upload-pdf">
            <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" aria-hidden="true"><path d="M8 11V2.5m0 0L5 5.5m3-3 3 3M3.5 10.5v2.2c0 .7.6 1.3 1.3 1.3h6.4c.7 0 1.3-.6 1.3-1.3v-2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="hidden sm:inline">Upload PDF</span><span class="sm:hidden">Upload</span>
          </button>
        </div>
      </div>
    </header>
    <input ref="fileInput" type="file" accept="application/pdf,.pdf" class="hidden" aria-label="Choose a PDF file" data-testid="pdf-file-input" @change="onPdfChoose" />

    <main>
      <section class="mx-auto max-w-[1440px] px-4 pb-12 pt-8 sm:px-7 sm:pt-11 lg:px-10">
        <div class="mb-7 flex flex-col justify-between gap-5 sm:mb-8 sm:flex-row sm:items-end">
          <div class="fade-in">
            <p class="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.2em] text-[#668071]"><span class="h-px w-6 bg-[#98ad9e]"></span> The local PDF workspace</p>
            <h1 class="font-[var(--serif)] text-[42px] leading-[.96] tracking-[-.025em] text-[#283a34] sm:text-[54px]">Sign with <em class="text-[#54816b]">certainty.</em></h1>
            <p class="mt-3 max-w-[500px] text-[13px] leading-6 text-[#718078] sm:text-[14px]">Add a signature, date, or note to your PDF. Your documents never leave this browser.</p>
          </div>
          <div class="flex items-center gap-3 fade-in-delay">
            <div class="hidden items-center gap-2 text-[11px] text-[#819088] md:flex"><span class="font-mono text-[10px] text-[#9ba69f]">01</span> Upload <span class="mx-1 h-px w-5 bg-[#cbd4cd]"></span><span class="font-mono text-[10px] text-[#9ba69f]">02</span> Place <span class="mx-1 h-px w-5 bg-[#cbd4cd]"></span><span class="font-mono text-[10px] text-[#9ba69f]">03</span> Save</div>
            <button v-if="hasDocument" @click="downloadPdf" :disabled="isExporting" class="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#356c5b] px-4 text-[12px] font-semibold text-white shadow-[0_3px_8px_rgba(39,73,58,.12)] transition hover:bg-[#285344] disabled:cursor-wait disabled:opacity-60" aria-label="Download signed PDF" data-testid="download-pdf">
              <svg v-if="!isExporting" viewBox="0 0 24 24" class="h-4 w-4" fill="none" aria-hidden="true"><path d="M12 3.5v11m0 0 4-4m-4 4-4-4M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span>{{ isExporting ? 'Preparing…' : 'Download PDF' }}</span>
            </button>
          </div>
        </div>

        <div class="overflow-hidden rounded-[18px] border border-[#d9e0d9] bg-[#fbfcf9] shadow-[0_10px_35px_rgba(42,59,47,.055)]">
          <div class="flex min-h-[62px] flex-wrap items-center justify-between gap-3 border-b border-[#e1e6e0] px-4 py-3 sm:px-5">
            <div class="flex min-w-0 items-center gap-3">
              <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#edf2ec] text-[#527262]">
                <svg viewBox="0 0 24 24" class="h-[17px] w-[17px]" fill="none" aria-hidden="true"><path d="M7 3.75h7l4.25 4.3v12.2H7a2 2 0 0 1-2-2v-12.5a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.5"/><path d="M14 4v4.5h4.2" stroke="currentColor" stroke-width="1.5"/></svg>
              </span>
              <div class="min-w-0">
                <p class="truncate text-[12px] font-semibold text-[#35453e]" data-testid="document-name">{{ fileName || 'Untitled document' }}</p>
                <p class="mt-[2px] text-[10px] text-[#8b9790]">{{ hasDocument ? `Page ${currentPage} of ${pages.length} · ${overlays.length} ${overlays.length === 1 ? 'mark' : 'marks'}` : statusLabel }}</p>
              </div>
            </div>
            <div v-if="hasDocument" class="flex items-center gap-2">
              <span class="hidden text-[10px] text-[#95a099] sm:inline">Saved locally as you work</span>
              <button @click="startOver" class="rounded-md px-2.5 py-2 text-[11px] font-medium text-[#738078] transition hover:bg-[#f0f3ef] hover:text-[#344a40]" aria-label="Close current PDF and start over" data-testid="start-over">Start over</button>
            </div>
            <span v-else class="flex items-center gap-1.5 rounded-full bg-[#f0f4ef] px-2.5 py-1.5 text-[10px] font-medium text-[#6e8376]"><svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" aria-hidden="true"><path d="M8 1.8 13 4v3.5c0 3.1-2.1 5.2-5 6.7-2.9-1.5-5-3.6-5-6.7V4l5-2.2Z" stroke="currentColor" stroke-width="1.3"/><path d="m5.7 7.8 1.5 1.5 3-3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> No upload to a server</span>
          </div>

          <div class="grid min-h-[560px] lg:grid-cols-[minmax(0,1fr)_250px]">
            <div class="relative min-w-0 bg-[#f1f3ef]">
              <div v-if="!hasDocument" class="flex min-h-[560px] items-center justify-center px-4 py-9 sm:px-8">
                <div @dragover.prevent="isDraggingFile = true" @dragleave.prevent="isDraggingFile = false" @drop.prevent="onDrop" :class="isDraggingFile ? 'border-[#54816b] bg-[#eff6ef] ring-4 ring-[#dcebe0]' : 'border-[#cbd7ce] bg-[#fbfcf9]'" class="relative w-full max-w-[650px] rounded-[16px] border border-dashed px-5 py-12 text-center transition-all sm:px-12 sm:py-[62px]" data-testid="upload-dropzone">
                  <div class="pointer-events-none absolute left-5 top-5 flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[.15em] text-[#9aa69e]"><span class="h-1.5 w-1.5 rounded-full bg-[#7e9d86]"></span> Your private workspace</div>
                  <div class="mx-auto mb-5 grid h-[68px] w-[68px] place-items-center rounded-[20px] bg-[#e9f0e9] text-[#527766]">
                    <svg viewBox="0 0 36 36" class="h-9 w-9" fill="none" aria-hidden="true"><path d="M11 4.75h10l6.25 6.4v17.1A2.75 2.75 0 0 1 24.5 31h-13A2.75 2.75 0 0 1 8.75 28.25V7.5A2.75 2.75 0 0 1 11.5 4.75Z" stroke="currentColor" stroke-width="1.6"/><path d="M21 5v6.5h6M18 16v8m0 0-3-3m3 3 3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  </div>
                  <h2 class="font-[var(--serif)] text-[30px] leading-tight text-[#31433a] sm:text-[34px]">Bring your document in.</h2>
                  <p class="mx-auto mt-2 max-w-[360px] text-[12px] leading-5 text-[#78867e]">Drop a PDF here, or choose a file from your device. It stays right here, from first page to final signature.</p>
                  <button @click="fileInput?.click()" class="mt-6 inline-flex h-11 items-center gap-2 rounded-lg bg-[#356c5b] px-5 text-[12px] font-semibold text-white transition hover:bg-[#285344]" aria-label="Choose a PDF from your device" data-testid="choose-pdf">
                    <svg viewBox="0 0 20 20" class="h-4 w-4" fill="none" aria-hidden="true"><path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M4 12.5v2.8A1.7 1.7 0 0 0 5.7 17h8.6a1.7 1.7 0 0 0 1.7-1.7v-2.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    Choose a PDF
                  </button>
                  <p class="mt-3 text-[10px] text-[#9aa49d]">PDF files up to 100 MB</p>
                  <div class="mx-auto mt-8 flex max-w-[400px] items-center justify-center gap-4 border-t border-[#e6ebe5] pt-5 text-[10px] text-[#89968e]">
                    <span class="flex items-center gap-1.5"><svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" aria-hidden="true"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2m-8 .2h9v6.3h-9V7.2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 9.2v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Private by default</span>
                    <span class="h-3 w-px bg-[#dce2dc]"></span><span>Nothing uploaded</span>
                  </div>
                </div>
              </div>
              <div v-else ref="viewerRef" class="pdf-scroll max-h-[780px] min-h-[560px] overflow-auto px-3 py-6 sm:px-7 sm:py-8" data-testid="pdf-viewer">
                <div class="mx-auto flex max-w-[850px] flex-col items-center gap-6">
                  <article v-for="page in pages" :key="page" :ref="el => setPageShell(page, el as Element | null)" :data-page-shell="page" class="relative w-full max-w-[720px] overflow-hidden bg-white shadow-[0_5px_20px_rgba(41,54,44,.14)] ring-1 ring-[#d9ded8]" :aria-label="`PDF page ${page}`" data-testid="pdf-page">
                    <canvas :ref="el => setPageCanvas(page, el as Element | null)" class="block h-auto w-full" :aria-label="`Rendered page ${page}`"></canvas>
                    <div v-for="item in overlays.filter(entry => entry.pageNumber === page)" :key="item.id" class="page-overlay absolute z-10 cursor-move" :class="selectedId === item.id ? 'outline outline-1 outline-dashed outline-[#56816c]' : 'hover:outline hover:outline-1 hover:outline-[#a4b6a8]'" :style="{ left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: `${item.width * 100}%`, height: `${item.height * 100}%` }" @pointerdown="beginOverlayPointer($event, item, 'move')" @click.stop="selectedId = item.id" :aria-label="`${item.kind} overlay, page ${page}`" data-testid="pdf-overlay">
                      <textarea v-if="item.kind === 'text'" v-model="item.text" @focus="selectedId = item.id" @pointerdown.stop @click.stop class="h-full w-full resize-none select-text overflow-hidden border-0 bg-transparent p-1 leading-tight text-[#263833] outline-none" :style="{ color: item.color || '#263833', fontSize: `${Math.max(9, (item.fontSize || 18) * (pageScales[page] || 1))}px` }" aria-label="Edit placed text" data-testid="overlay-text"></textarea>
                      <img v-else :src="item.dataUrl" :alt="item.kind === 'signature' ? 'Placed signature' : 'Placed image'" :style="{ opacity: item.opacity ?? 1 }" class="h-full w-full object-contain" draggable="false" />
                      <span v-if="selectedId === item.id && item.kind === 'text'" @pointerdown="beginOverlayPointer($event, item, 'move')" class="absolute -top-5 left-0 rounded-t bg-[#56816c] px-2 py-0.5 text-[8px] font-semibold text-white" aria-label="Drag text mark to move" data-testid="overlay-move-handle">Move</span>
                      <button v-if="selectedId === item.id" @pointerdown.stop @click.stop="deleteSelected" class="absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full border border-white bg-[#bd6651] text-white shadow-sm" aria-label="Delete selected mark" data-testid="overlay-delete"><svg viewBox="0 0 12 12" class="h-3 w-3" fill="none" aria-hidden="true"><path d="m3 3 6 6m0-6L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
                      <span v-if="selectedId === item.id" @pointerdown="beginOverlayPointer($event, item, 'resize')" class="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-[3px] border-2 border-white bg-[#56816c] shadow" aria-label="Resize mark" data-testid="overlay-resize"></span>
                    </div>
                    <div class="pointer-events-none absolute bottom-2 right-3 rounded bg-white/85 px-1.5 py-0.5 font-mono text-[9px] text-[#929b94]">{{ page }} / {{ pages.length }}</div>
                  </article>
                </div>
              </div>
              <div v-if="isLoading" class="absolute inset-0 z-20 flex items-center justify-center bg-[#f1f3ef]/90 p-5" aria-live="polite" data-testid="loading-state">
                <div class="w-full max-w-[460px] rounded-xl border border-[#dde4dc] bg-[#fbfcf9] p-5">
                  <div class="mb-5 h-3 w-40 animate-pulse rounded bg-[#e3e9e2]"></div><div class="space-y-3"><div class="h-3 animate-pulse rounded bg-[#e7ece6]"></div><div class="h-3 w-4/5 animate-pulse rounded bg-[#e7ece6]"></div><div class="h-3 w-3/5 animate-pulse rounded bg-[#e7ece6]"></div><div class="mt-5 h-24 animate-pulse rounded bg-[#edf1ec]"></div></div>
                  <p class="mt-4 text-[11px] font-medium text-[#6c7f73]">Opening locally…</p>
                </div>
              </div>
              <div v-if="errorMessage" class="absolute bottom-4 left-4 right-4 z-30 flex items-center justify-between gap-3 rounded-lg border border-[#ead3ca] bg-[#fff8f5] px-4 py-3 text-[11px] text-[#985845] shadow-sm" role="alert" data-testid="error-message">
                <span>{{ errorMessage }}</span><button @click="errorMessage = ''" class="shrink-0 rounded px-2 py-1 font-semibold hover:bg-[#f8e9e3]" aria-label="Dismiss error" data-testid="dismiss-error">Dismiss</button>
              </div>
            </div>

            <aside class="border-t border-[#e1e6e0] bg-[#fbfcf9] lg:border-l lg:border-t-0" aria-label="Document tools and properties">
              <div class="flex h-full flex-col">
                <div class="border-b border-[#e6eae5] px-4 py-4">
                  <div class="mb-3 flex items-center justify-between">
                    <p class="text-[10px] font-bold uppercase tracking-[.16em] text-[#68786f]">Add to document</p>
                    <span class="font-mono text-[9px] text-[#a2aaa4]">TOOLS</span>
                  </div>
                  <div class="grid grid-cols-3 gap-2">
                    <button @click="addText" :disabled="!hasDocument" :class="activeTool === 'text' ? 'border-[#9bb6a1] bg-[#edf4ed] text-[#356c5b]' : ''" class="flex min-h-[67px] flex-col items-center justify-center gap-2 rounded-lg border border-[#e1e6e0] bg-[#fffefa] text-[#61736a] transition hover:border-[#afc2b2] hover:bg-[#f2f6f1] disabled:cursor-not-allowed disabled:opacity-40" aria-label="Add text to PDF" data-testid="tool-add-text">
                      <svg viewBox="0 0 20 20" class="h-[18px] w-[18px]" fill="none" aria-hidden="true"><path d="M3.5 5V3.8h13V5M10 4v12m-3 0h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="text-[10px] font-semibold">Text</span>
                    </button>
                    <button @click="hasDocument && openSignature()" :disabled="!hasDocument" :class="activeTool === 'signature' ? 'border-[#9bb6a1] bg-[#edf4ed] text-[#356c5b]' : ''" class="flex min-h-[67px] flex-col items-center justify-center gap-2 rounded-lg border border-[#e1e6e0] bg-[#fffefa] text-[#61736a] transition hover:border-[#afc2b2] hover:bg-[#f2f6f1] disabled:cursor-not-allowed disabled:opacity-40" aria-label="Create a signature" data-testid="tool-signature">
                      <svg viewBox="0 0 20 20" class="h-[18px] w-[18px]" fill="none" aria-hidden="true"><path d="M3 14.5c2.4-4.2 3.6-6.3 4.5-5.7.7.5-.9 4.1-.1 4.6.7.6 2.5-2.6 3.4-2.1.7.4.1 2 1.2 2 1 0 2.1-1.1 4.7-1.2M3.2 17h13.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="text-[10px] font-semibold">Signature</span>
                    </button>
                     <button @click="hasDocument && imageInput?.click()" :disabled="!hasDocument" class="flex min-h-[67px] flex-col items-center justify-center gap-2 rounded-lg border border-[#e1e6e0] bg-[#fffefa] text-[#61736a] transition hover:border-[#afc2b2] hover:bg-[#f2f6f1] disabled:cursor-not-allowed disabled:opacity-40" aria-label="Add an image or stamp to PDF" data-testid="tool-image">
                       <svg viewBox="0 0 20 20" class="h-[18px] w-[18px]" fill="none" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.4"/><circle cx="7.2" cy="7.2" r="1.4" stroke="currentColor" stroke-width="1.3"/><path d="m4.3 15 4-4 2.7 2.6 2-2 2.7 2.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="text-[10px] font-semibold">Image Sign/Stamp</span>
                    </button>
                  </div>
                   <input ref="imageInput" type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" class="hidden" aria-label="Choose a PNG or JPG stamp image" data-testid="image-file-input" @change="onImageChoose" />
                </div>

                <div class="flex-1 px-4 py-4">
                  <template v-if="selectedOverlay">
                    <div class="mb-4 flex items-center justify-between">
                      <div><p class="text-[10px] font-bold uppercase tracking-[.16em] text-[#68786f]">Properties</p><p class="mt-1 text-[11px] capitalize text-[#9aa39c]">{{ selectedOverlay.kind }} · page {{ selectedOverlay.pageNumber }}</p></div>
                      <button @click="deleteSelected" class="grid h-8 w-8 place-items-center rounded-md text-[#a66a58] transition hover:bg-[#f8ece7]" aria-label="Delete selected element" data-testid="delete-selected">
                        <svg viewBox="0 0 20 20" class="h-4 w-4" fill="none" aria-hidden="true"><path d="M4.5 6h11m-9.5 0 .6 10h7.8l.6-10M8 6V4.3h4V6m-3 3v4m2-4v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                      </button>
                    </div>
                    <label v-if="selectedOverlay.kind === 'text'" class="mb-4 block">
                      <span class="mb-1.5 block text-[10px] font-semibold text-[#6e7c74]">Text</span>
                      <textarea v-model="selectedOverlay.text" rows="3" class="w-full resize-y rounded-md border border-[#dce3dc] bg-white px-2.5 py-2 text-[11px] text-[#35453e] outline-none transition focus:border-[#87a691]" aria-label="Edit text content" data-testid="property-text"></textarea>
                    </label>
                    <label v-if="selectedOverlay.kind === 'text'" class="mb-4 block">
                      <span class="mb-1.5 flex justify-between text-[10px] font-semibold text-[#6e7c74]"><span>Font size</span><span class="font-mono font-normal">{{ selectedOverlay.fontSize }} pt</span></span>
                      <input type="range" min="8" max="48" step="1" :value="selectedOverlay.fontSize || 18" @input="updateSelected('fontSize', Number(($event.target as HTMLInputElement).value))" class="w-full accent-[#54816b]" aria-label="Adjust text size" data-testid="property-font-size" />
                    </label>
                    <label v-if="selectedOverlay.kind === 'text'" class="mb-4 block">
                      <span class="mb-1.5 block text-[10px] font-semibold text-[#6e7c74]">Ink color</span>
                      <div class="flex items-center gap-2 rounded-md border border-[#dce3dc] bg-white px-2 py-1.5">
                        <input type="color" :value="selectedOverlay.color || '#263833'" @input="updateSelected('color', ($event.target as HTMLInputElement).value)" class="h-6 w-7 cursor-pointer border-0 bg-transparent p-0" aria-label="Choose text color" data-testid="property-text-color" /><span class="font-mono text-[10px] uppercase text-[#7a8980]">{{ selectedOverlay.color || '#263833' }}</span>
                      </div>
                    </label>
                    <label v-if="selectedOverlay.kind === 'image' || selectedOverlay.kind === 'signature'" class="mb-4 block">
                      <span class="mb-1.5 flex justify-between text-[10px] font-semibold text-[#6e7c74]"><span>Opacity</span><span class="font-mono font-normal">{{ Math.round((selectedOverlay.opacity ?? 1) * 100) }}%</span></span>
                      <input type="range" min="0.15" max="1" step="0.05" :value="selectedOverlay.opacity ?? 1" @input="updateSelected('opacity', Number(($event.target as HTMLInputElement).value))" class="w-full accent-[#54816b]" aria-label="Adjust image opacity" data-testid="property-opacity" />
                    </label>
                    <div class="mb-4 rounded-md bg-[#f1f5f0] p-3 text-[10px] leading-[1.55] text-[#75847a]">
                      <p class="mb-1 font-semibold text-[#536b5c]">On the page</p>
                      Drag to move. Pull the corner handle to resize.
                    </div>
                    <button @click="selectedId = null" class="w-full rounded-md border border-[#dce3dc] bg-white py-2 text-[10px] font-semibold text-[#65756c] transition hover:bg-[#f5f7f3]" aria-label="Deselect current element" data-testid="deselect-element">Done editing</button>
                  </template>
                  <div v-else class="flex min-h-[142px] flex-col items-center justify-center rounded-lg border border-dashed border-[#dfe5df] bg-[#f8faf6] px-4 text-center" data-testid="property-empty">
                    <span class="mb-2 grid h-8 w-8 place-items-center rounded-full bg-[#edf2ec] text-[#829489]">
                      <svg viewBox="0 0 20 20" class="h-4 w-4" fill="none" aria-hidden="true"><path d="M4 5.5h12M4 10h8M4 14.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                    </span>
                    <p class="text-[11px] font-semibold text-[#617268]">Nothing selected</p>
                    <p class="mt-1 max-w-[165px] text-[10px] leading-4 text-[#98a39b]">Choose a tool, then select a mark on your page to edit it.</p>
                  </div>
                  <div v-if="!hasDocument" class="mt-4 rounded-lg bg-[#f1f5f0] px-3 py-3 text-[10px] leading-[1.55] text-[#7b897f]">
                    <p class="mb-1 font-semibold text-[#5b7462]">A note on privacy</p>
                    We process your document in this browser only. No account, no upload, no copies on our servers.
                  </div>
                </div>
                <div class="border-t border-[#e6eae5] px-4 py-3">
                  <div class="flex items-center gap-2 text-[10px] text-[#819087]"><svg viewBox="0 0 16 16" class="h-3.5 w-3.5 text-[#648372]" fill="none" aria-hidden="true"><path d="M8 1.8 13 4v3.5c0 3.1-2.1 5.2-5 6.7-2.9-1.5-5-3.6-5-6.7V4l5-2.2Z" stroke="currentColor" stroke-width="1.25"/><path d="m5.7 7.8 1.5 1.5 3-3.2" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg> Nothing leaves this browser</div>
                </div>
              </div>
            </aside>
          </div>
        </div>
        <div class="mt-3 flex flex-wrap items-center justify-between gap-2 px-1 text-[10px] text-[#89958d]">
          <span>Private, free, and ready when you are.</span>
          <span class="flex items-center gap-1.5"><span class="h-1.5 w-1.5 rounded-full bg-[#7da087]"></span> Processed locally on your device</span>
        </div>
        <div class="mt-5 flex min-h-[72px] items-center justify-center rounded-lg border border-dashed border-[#dce3dc] bg-[#f9faf6] px-4 text-center" aria-label="Advertisement space" data-testid="ad-space">
          <span class="text-[10px] font-medium uppercase tracking-[.18em] text-[#a0aaa2]">Ad Space</span>
        </div>
      </section>

      <section id="how-it-works" class="border-y border-[#e0e5de] bg-[#eaf0e8]">
        <div class="mx-auto grid max-w-[1440px] gap-10 px-4 py-14 sm:px-7 sm:py-[72px] lg:grid-cols-[.8fr_1.2fr] lg:gap-20 lg:px-10">
          <div class="max-w-[420px]">
            <p class="mb-3 text-[10px] font-bold uppercase tracking-[.2em] text-[#63806d]">A straightforward process</p>
            <h2 class="font-[var(--serif)] text-[38px] leading-[1.02] tracking-[-.02em] text-[#2d4036] sm:text-[45px]">Three steps.<br><em>No detours.</em></h2>
            <p class="mt-4 max-w-[330px] text-[12px] leading-6 text-[#718078]">The tools you need, without handing your paperwork to a third party.</p>
            <div class="mt-6 flex items-center gap-2 text-[10px] font-semibold text-[#637b6b]"><span class="grid h-6 w-6 place-items-center rounded-full border border-[#b7cabb] text-[9px]">LOCAL</span> Your file stays in your browser throughout.</div>
          </div>
          <div class="grid gap-3 sm:grid-cols-3">
            <article class="relative rounded-xl border border-[#d5e0d5] bg-[#f8faf6] p-5 sm:mt-7" data-testid="step-upload">
              <span class="font-mono text-[10px] text-[#8ca093]">01 / OPEN</span>
              <div class="my-5 grid h-10 w-10 place-items-center rounded-lg bg-[#e8f0e8] text-[#537661]"><svg viewBox="0 0 22 22" class="h-5 w-5" fill="none" aria-hidden="true"><path d="M11 14V3.5m0 0L7 7.5m4-4 4 4M4 13.5v3.2A1.8 1.8 0 0 0 5.8 18.5h10.4a1.8 1.8 0 0 0 1.8-1.8v-3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
              <h3 class="text-[13px] font-semibold text-[#34473d]">Open your PDF</h3><p class="mt-2 text-[11px] leading-[1.65] text-[#7e8b82]">Choose a file or drop it into the workspace. It opens right in your browser.</p>
            </article>
            <article class="rounded-xl border border-[#d5e0d5] bg-[#f8faf6] p-5 sm:mt-3" data-testid="step-mark">
              <span class="font-mono text-[10px] text-[#8ca093]">02 / MARK</span>
              <div class="my-5 grid h-10 w-10 place-items-center rounded-lg bg-[#e8f0e8] text-[#537661]"><svg viewBox="0 0 22 22" class="h-5 w-5" fill="none" aria-hidden="true"><path d="M4 15c2.5-4.5 3.8-6.8 4.8-6.2.8.6-1 4.4-.1 5 .8.6 2.7-2.8 3.7-2.2.8.5.1 2.2 1.3 2.2s2.3-1.2 4.8-1.3M4 18h14" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg></div>
              <h3 class="text-[13px] font-semibold text-[#34473d]">Add what you need</h3><p class="mt-2 text-[11px] leading-[1.65] text-[#7e8b82]">Draw a signature, place a note, or add an image. Move and resize each mark.</p>
            </article>
            <article class="relative rounded-xl border border-[#d5e0d5] bg-[#f8faf6] p-5 sm:mt-10" data-testid="step-save">
              <span class="font-mono text-[10px] text-[#8ca093]">03 / SAVE</span>
              <div class="my-5 grid h-10 w-10 place-items-center rounded-lg bg-[#e8f0e8] text-[#537661]"><svg viewBox="0 0 22 22" class="h-5 w-5" fill="none" aria-hidden="true"><path d="M11 3.5v11m0 0 4-4m-4 4-4-4M4 16v1.8A1.7 1.7 0 0 0 5.7 19.5h10.6a1.7 1.7 0 0 0 1.7-1.7V16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
              <h3 class="text-[13px] font-semibold text-[#34473d]">Save your copy</h3><p class="mt-2 text-[11px] leading-[1.65] text-[#7e8b82]">Download a new signed PDF. Your original file stays untouched on your device.</p>
            </article>
          </div>
        </div>
      </section>

      <section class="mx-auto grid max-w-[1440px] gap-12 px-4 py-14 sm:px-7 sm:py-[68px] lg:grid-cols-1 lg:gap-20 lg:px-10">
        <div>
          <p class="mb-3 text-[10px] font-bold uppercase tracking-[.2em] text-[#68806f]">Good to know</p>
          <h2 class="font-[var(--serif)] text-[36px] leading-none tracking-[-.02em] text-[#304139]">A few clear answers.</h2>
          <div class="mt-7 max-w-[760px] divide-y divide-[#e0e5df] border-y border-[#e0e5df]">
            <div v-for="(faq, index) in [
              { q: 'How does offline PDF signing work?', a: 'Once this page is open, PDF.js renders your pages and pdf-lib adds text, signatures, and stamps directly in your browser. The document bytes are never uploaded.' },
              { q: 'Does my PDF get uploaded anywhere?', a: 'No. Your file is opened and processed on this device only. LocalSign does not send your document to a server or require an account.' },
              { q: 'Will my original PDF be changed?', a: 'No. Download creates a separate signed copy and leaves your original file as it was. Keep the downloaded copy somewhere safe when you are done.' },
              { q: 'Can I add more than one signature or mark?', a: 'Yes. Add text notes, signatures, and images across the document pages. Select a mark to adjust it or remove it before downloading.' }
            ]" :key="faq.q" class="py-4">
              <button @click="toggleFaq(index)" class="flex w-full items-center justify-between gap-4 text-left" :aria-expanded="faqs[index]" :aria-label="`${faqs[index] ? 'Hide' : 'Show'} answer: ${faq.q}`" :data-testid="`faq-${index + 1}`">
                <span class="text-[12px] font-semibold text-[#405148]">{{ faq.q }}</span>
                <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[#dce3dc] text-[#65806e] transition" :class="faqs[index] ? 'rotate-45 bg-[#edf3ed]' : ''"><svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" aria-hidden="true"><path d="M8 3.5v9m-4.5-4.5h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></span>
              </button>
              <p v-if="faqs[index]" class="max-w-[620px] pr-8 pt-3 text-[11px] leading-[1.75] text-[#7b8980]" data-testid="faq-answer">{{ faq.a }}</p>
            </div>
          </div>
        </div>
      </section>
    </main>

    <footer class="border-t border-[#e0e5df] bg-[#eef1ec]">
      <div class="mx-auto flex max-w-[1440px] flex-col items-start justify-between gap-3 px-4 py-5 text-[10px] text-[#839087] sm:flex-row sm:items-center sm:px-7 lg:px-10">
        <span class="font-semibold tracking-[-.02em] text-[#5b7163]">localsign.pdf <span class="font-normal text-[#96a198]">— a quieter way to sign.</span></span>
        <span>Private by design. Processed on your device.</span>
      </div>
    </footer>

    <div v-if="signatureOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-[#20372d]/35 p-4 backdrop-blur-[2px]" @click.self="closeSignature" role="presentation" data-testid="signature-modal-backdrop">
      <section class="w-full max-w-[520px] overflow-hidden rounded-[16px] border border-[#dce3dc] bg-[#fbfcf9] shadow-[0_24px_80px_rgba(28,49,37,.24)]" role="dialog" aria-modal="true" aria-labelledby="signature-title" data-testid="signature-modal">
        <div class="flex items-start justify-between border-b border-[#e4e9e3] px-5 py-4 sm:px-6">
          <div><p class="mb-1 text-[9px] font-bold uppercase tracking-[.17em] text-[#708a78]">Your mark, your way</p><h2 id="signature-title" class="font-[var(--serif)] text-[27px] leading-none text-[#304239]">Draw a signature</h2></div>
          <button @click="closeSignature" class="grid h-8 w-8 place-items-center rounded-md text-[#7e8c82] hover:bg-[#edf1eb]" aria-label="Cancel signature" data-testid="signature-close"><svg viewBox="0 0 18 18" class="h-4 w-4" fill="none" aria-hidden="true"><path d="m4 4 10 10M14 4 4 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
        </div>
        <div class="px-5 pt-5 sm:px-6">
          <div class="mb-3 flex items-center justify-between">
            <div class="flex items-center gap-2" role="group" aria-label="Signature ink color">
              <button v-for="color in [{ value: '#000000', label: 'Black ink' }, { value: '#315ca5', label: 'Blue ink' }, { value: '#b33f48', label: 'Red ink' }]" :key="color.value" @click="signatureColor = color.value" :class="signatureColor === color.value ? 'ring-2 ring-[#90ab96] ring-offset-2' : ''" class="h-5 w-5 rounded-full border border-black/10 transition-transform hover:scale-110" :style="{ backgroundColor: color.value }" :aria-label="color.label" :aria-pressed="signatureColor === color.value" :data-testid="`signature-color-${color.value.slice(1)}`"></button>
            </div>
            <button @click="clearSignature" class="text-[10px] font-semibold text-[#738178] underline decoration-[#c3cec4] underline-offset-4 hover:text-[#365d49]" aria-label="Clear signature drawing" data-testid="signature-clear">Clear</button>
          </div>
          <div class="overflow-hidden rounded-lg border border-[#dce3dc] bg-white">
            <canvas ref="signatureCanvas" class="signature-canvas block h-[180px] w-full cursor-crosshair touch-none" aria-label="Draw your signature here" data-testid="signature-canvas"></canvas>
          </div>
          <p class="mt-2 text-[10px] text-[#9aa49c]">Use your mouse, trackpad, or finger to sign.</p>
        </div>
        <div class="mt-5 flex items-center justify-between border-t border-[#e4e9e3] bg-[#f7f9f5] px-5 py-4 sm:px-6">
          <button @click="closeSignature" class="rounded-md px-3 py-2 text-[11px] font-semibold text-[#738078] hover:bg-[#edf1eb]" aria-label="Cancel and close signature drawing" data-testid="signature-cancel">Cancel</button>
          <button @click="saveSignature" :disabled="!hasSignatureInk" class="inline-flex h-9 items-center gap-2 rounded-lg bg-[#356c5b] px-4 text-[11px] font-semibold text-white transition hover:bg-[#285344] disabled:cursor-not-allowed disabled:opacity-45" aria-label="Save signature to the PDF" data-testid="signature-save"><svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" aria-hidden="true"><path d="m3 8.5 3.2 3.2L13 4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg> Save signature</button>
        </div>
      </section>
    </div>
  </div>
</template>
