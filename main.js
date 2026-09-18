import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildVectorSvg } from "./svg-export.js";
import { getExportFont, getCompositionContours, FONT_FAMILY } from "./outline.js";

// Bundled brand font — single family, selectable weight (Regular / Bold).
const FONT_URLS = {
  400: "./fonts/ALSChromius-Regular.otf",
  700: "./fonts/ALSChromius-Bold.otf",
};
const SPHERE_COLOR = "#000000"; // fixed; only visible when sphere is opaque
const MAX_BLOCKS = 4;

// Lens focal length, in the 35 mm-equivalent sense (three.js `filmGauge` = 35).
// Short = strong perspective, long = flat "telephoto" look.
const MIN_FOCAL_LENGTH = 24;
const MAX_FOCAL_LENGTH = 200;
const DEFAULT_FOCAL_LENGTH = 100;

const canvas = document.getElementById("canvas");
const viewport = document.querySelector(".viewport");
const blocksContainer = document.getElementById("blocks");
const addBlockBtn = document.getElementById("add-block-btn");
const blockTemplate = document.getElementById("block-template");
const fontsStatus = document.getElementById("fonts-status");
const blockGapInput = document.getElementById("block-gap");
const blockGapValue = document.getElementById("block-gap-value");
const textAngleInput = document.getElementById("text-angle");
const textAngleValue = document.getElementById("text-angle-value");
const scaleInput = document.getElementById("scale");
const scaleValue = document.getElementById("scale-value");
const focalLengthInput = document.getElementById("focal-length");
const textColorInput = document.getElementById("text-color");
const pageBgColorInput = document.getElementById("page-bg-color");
const transparentSphereInput = document.getElementById("transparent-sphere");
const debugBoundsInput = document.getElementById("debug-bounds");
const debugToggleBtn = document.getElementById("debug-toggle");
const alignButtons = [...document.querySelectorAll(".segmented__btn[data-align]")];
const saveBtn = document.getElementById("save-btn");
const exportSettingsBtn = document.getElementById("export-settings-btn");
const importSettingsBtn = document.getElementById("import-settings-btn");

const TEXTURE_WIDTH = 2048;
const TEXTURE_HEIGHT = 1024;
const SPHERE_RADIUS = 1.65;
// Visible half-height (world units) at the sphere centre that counts as "framed".
// Matches the framing the old fixed 45° camera produced at its start distance.
const FRAME_HALF_HEIGHT = SPHERE_RADIUS * 1.3;

const textureCanvas = document.createElement("canvas");
textureCanvas.width = TEXTURE_WIDTH;
textureCanvas.height = TEXTURE_HEIGHT;
const textureContext = textureCanvas.getContext("2d");

const texture = new THREE.CanvasTexture(textureCanvas);
texture.colorSpace = THREE.SRGBColorSpace;
texture.anisotropy = 8;

const scene = new THREE.Scene();
scene.background = new THREE.Color(pageBgColorInput.value);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
// Start looking at the text: the texture centre maps to +X on the sphere (u=0.5
// -> theta=pi), so a camera on +Z would only catch it edge-on at the silhouette.
// The distance here is nominal — applyCameraFraming() derives it from the lens.
camera.position.set(5.2, 0, 0);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

// Unlit material: texture shown flat, at true colours, with no shading.
const sphereGeometry = new THREE.SphereGeometry(SPHERE_RADIUS, 96, 96);
const sphereMaterial = new THREE.MeshBasicMaterial({ map: texture });
const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
scene.add(sphere);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.rotateSpeed = 0.75;

// --- Camera framing ---------------------------------------------------------

let focalLength = DEFAULT_FOCAL_LENGTH;
// Camera distance expressed relative to the framed distance, so the user's zoom
// survives focal-length changes and window resizes. 1 = sphere framed as designed.
let zoomFactor = 1;

/**
 * Distance at which the sphere fills the frame identically for any focal length
 * or viewport aspect. `getFilmHeight()` is aspect-dependent (the 35 mm gauge is
 * horizontal), so this has to be recomputed on resize, not just on lens changes.
 */
function framedDistance() {
  const vExtentSlope = (0.5 * camera.getFilmHeight()) / focalLength;
  return FRAME_HALF_HEIGHT / vExtentSlope;
}

/**
 * Re-derive the FOV from the focal length and dolly the camera so the sphere
 * keeps its size in frame. That makes the control change perspective distortion
 * rather than zoom — a 200 mm view is flatter, not closer.
 */
function applyCameraFraming() {
  camera.setFocalLength(focalLength); // also updates the projection matrix

  const framed = framedDistance();
  controls.minDistance = framed * 0.5;
  controls.maxDistance = framed * 2;

  const distance = Math.min(Math.max(framed * zoomFactor, controls.minDistance), controls.maxDistance);
  const direction = camera.position.clone().sub(controls.target);
  if (direction.lengthSq() === 0) direction.set(0, 0, 1);
  camera.position.copy(controls.target).addScaledVector(direction.normalize(), distance);
  controls.update();
}

function updateFocalLength(value) {
  focalLength = Math.min(MAX_FOCAL_LENGTH, Math.max(MIN_FOCAL_LENGTH, Math.round(value)));
  applyCameraFraming();
}

// --- Text composition state -------------------------------------------------

let blockSeq = 0;
const blocksState = [];

function makeBlock(overrides = {}) {
  blockSeq += 1;
  // Bold is the only weight offered publicly; the Regular option lives behind
  // debug mode, so new blocks start bold.
  return { id: `b${blockSeq}`, text: "", weight: 700, size: 96, lineFactor: 0.8, ...overrides };
}

blocksState.push(
  makeBlock({ text: "Самый\nбольшой\nприз", weight: 700, size: 110, lineFactor: 0.8 }),
);

// Global horizontal alignment of the rows inside the composition box: "center"
// (every row centred on its own) or "left" (all rows flush to the box's left
// edge). The box itself stays centred on the sphere either way.
let textAlign = "center";

function getGlobalSettings() {
  return {
    scale: Number(scaleInput.value) / 100,
    betweenFactor: Number(blockGapInput.value) / 100,
    angleRadians: (Number(textAngleInput.value) * Math.PI) / 180,
    textColor: textColorInput.value,
    align: textAlign,
  };
}

function wrapLines(context, lines, maxWidth) {
  const wrapped = [];
  for (const sourceLine of lines) {
    const words = sourceLine.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      wrapped.push("");
      continue;
    }
    let currentLine = words[0];
    for (let index = 1; index < words.length; index += 1) {
      const candidate = `${currentLine} ${words[index]}`;
      if (context.measureText(candidate).width <= maxWidth) {
        currentLine = candidate;
      } else {
        wrapped.push(currentLine);
        currentLine = words[index];
      }
    }
    wrapped.push(currentLine);
  }
  return wrapped;
}

/**
 * Turn the block list into a flat, vertically-positioned list of rows.
 * Each row: { text, weight, sizePx, centerY } where centerY is the row's
 * vertical centre relative to the texture centre. Wrapping is done once here
 * (canvas metrics) and reused by both the preview and the SVG export.
 */
function buildComposition() {
  const global = getGlobalSettings();

  // Per-block: scaled size + wrapped lines. Empty blocks are skipped.
  const flat = [];
  blocksState.forEach((block, blockIndex) => {
    const text = block.text.replace(/\r/g, "");
    if (text.trim() === "") return;

    const sizePx = Math.max(1, block.size * global.scale);
    textureContext.font = `${block.weight} ${sizePx}px "${FONT_FAMILY}", sans-serif`;
    const wrapped = wrapLines(textureContext, text.split("\n"), TEXTURE_WIDTH * 0.72);

    for (const line of wrapped) {
      // The font is already set for this block, so measure the row while we are
      // here: alignment and the debug box both need the row widths.
      flat.push({
        text: line,
        weight: block.weight,
        sizePx,
        lineFactor: block.lineFactor,
        blockIndex,
        width: textureContext.measureText(line).width,
      });
    }
  });

  if (flat.length === 0) {
    return {
      rows: [],
      angleRadians: global.angleRadians,
      textColor: global.textColor,
      align: global.align,
      maxWidth: 0,
    };
  }

  // Vertical advances: within a block -> its own line-height; between blocks ->
  // the global "distance between blocks" factor times the average adjacent size.
  const ys = [];
  let y = 0;
  for (let i = 0; i < flat.length; i += 1) {
    if (i === 0) {
      ys.push(0);
      continue;
    }
    const prev = flat[i - 1];
    const cur = flat[i];
    const advance =
      cur.blockIndex === prev.blockIndex
        ? cur.sizePx * cur.lineFactor
        : global.betweenFactor * ((prev.sizePx + cur.sizePx) / 2);
    y += advance;
    ys.push(y);
  }

  const total = ys[ys.length - 1];
  flat.forEach((row, i) => {
    row.centerY = ys[i] - total / 2;
  });

  return {
    rows: flat,
    angleRadians: global.angleRadians,
    textColor: global.textColor,
    align: global.align,
    maxWidth: Math.max(...flat.map((row) => row.width)),
  };
}

function drawComposition(context, composition) {
  if (composition.rows.length === 0) return;

  const flushLeft = composition.align === "left";

  context.fillStyle = composition.textColor;
  context.textAlign = flushLeft ? "left" : "center";
  context.textBaseline = "middle";

  context.save();
  context.translate(TEXTURE_WIDTH / 2, TEXTURE_HEIGHT / 2);
  context.rotate(composition.angleRadians);

  // Left alignment flushes every row to the box's left edge; centre alignment
  // centres each row on its own. Either way the box stays centred on the sphere.
  const originX = flushLeft ? -composition.maxWidth / 2 : 0;

  for (const row of composition.rows) {
    if (!row.text) continue;
    context.font = `${row.weight} ${row.sizePx}px "${FONT_FAMILY}", sans-serif`;
    context.fillText(row.text, originX, row.centerY);
  }

  context.restore();
}

/**
 * Vertical extent of the composition box, relative to its centre. Rows are drawn
 * with `textBaseline = "middle"`, so each occupies its em box: `sizePx` tall,
 * centred on `centerY`.
 */
function compositionExtent(rows) {
  let top = Infinity;
  let bottom = -Infinity;
  for (const row of rows) {
    top = Math.min(top, row.centerY - row.sizePx / 2);
    bottom = Math.max(bottom, row.centerY + row.sizePx / 2);
  }
  return { top, bottom };
}

/**
 * Debug overlay: fills the composition's bounding box so its width and height
 * are readable as they wrap around the sphere. Preview only — the SVG export
 * builds its geometry from glyph outlines and never reads this texture.
 */
function drawContainerBounds(context, composition) {
  if (composition.rows.length === 0) return;

  const { top, bottom } = compositionExtent(composition.rows);

  context.save();
  context.translate(TEXTURE_WIDTH / 2, TEXTURE_HEIGHT / 2);
  context.rotate(composition.angleRadians);
  context.fillStyle = contrastColor(composition.textColor);
  context.fillRect(-composition.maxWidth / 2, top, composition.maxWidth, bottom - top);
  context.restore();
}

function drawTexture() {
  const composition = buildComposition();

  textureContext.clearRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
  if (!transparentSphereInput.checked) {
    textureContext.fillStyle = SPHERE_COLOR;
    textureContext.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
  }
  if (debugBoundsInput.checked) {
    drawContainerBounds(textureContext, composition);
  }
  drawComposition(textureContext, composition);
  texture.needsUpdate = true;
}

function applySphereTransparency() {
  const transparent = transparentSphereInput.checked;
  sphereMaterial.transparent = transparent;
  sphereMaterial.alphaTest = transparent ? 0.5 : 0;
  sphereMaterial.needsUpdate = true;
  drawTexture();
}

function parseHexColor(hex) {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function toHexColor(channels) {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsl([r, g, b]) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, lightness];

  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === rn) hue = ((gn - bn) / delta) % 6;
  else if (max === gn) hue = (bn - rn) / delta + 2;
  else hue = (rn - gn) / delta + 4;
  hue *= 60;
  return [hue < 0 ? hue + 360 : hue, saturation, lightness];
}

function hslToRgb(hue, saturation, lightness) {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60;
  const x = c * (1 - Math.abs((sector % 2) - 1));
  let rgb;
  if (sector < 1) rgb = [c, x, 0];
  else if (sector < 2) rgb = [x, c, 0];
  else if (sector < 3) rgb = [0, c, x];
  else if (sector < 4) rgb = [0, x, c];
  else if (sector < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = lightness - c / 2;
  return rgb.map((channel) => Math.round((channel + m) * 255));
}

function mixHexColor(hex, amount) {
  const mixed = parseHexColor(hex).map((channel) =>
    Math.min(255, Math.round(channel + (255 - channel) * amount)),
  );
  return toHexColor(mixed);
}

/**
 * A colour that reads clearly against `hex`. Plain channel inversion is not
 * enough: inverting a mid-lightness colour like #ff6a00 lands on a blue of
 * almost the same lightness, and forcing that to the dark end would bury the
 * fill in the black sphere. So take the opposite hue and push the lightness to
 * the far side of the text's, keeping a saturation floor so grey text still
 * yields a coloured box.
 */
function contrastColor(hex) {
  const [hue, saturation, lightness] = rgbToHsl(parseHexColor(hex));
  return toHexColor(
    hslToRgb((hue + 180) % 360, Math.max(saturation, 0.55), lightness > 0.5 ? 0.32 : 0.68),
  );
}

function updatePageBackground(color) {
  scene.background.set(color);
  document.body.style.background = color;
  viewport.style.background = `radial-gradient(circle at 50% 40%, ${mixHexColor(color, 0.12)} 0%, ${color} 72%)`;
}

function setFontsStatus(message) {
  fontsStatus.textContent = message;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Snapshot of everything that defines the current look, meant to be read back
 * as a preset. The camera orbit is stored as angles plus a zoom factor relative
 * to the framed distance rather than as raw coordinates, so a preset reproduces
 * the same view in a window of any size.
 */
function collectSettings() {
  const global = getGlobalSettings();
  const composition = buildComposition();
  const degrees = (radians) => round((radians * 180) / Math.PI);
  const extent = composition.rows.length
    ? compositionExtent(composition.rows)
    : { top: 0, bottom: 0 };

  return {
    format: "sphere-typography/settings",
    version: 1,
    exportedAt: new Date().toISOString(),
    camera: {
      focalLengthMm: focalLength,
      fovDeg: round(camera.fov),
      filmGaugeMm: camera.filmGauge,
      azimuthDeg: degrees(controls.getAzimuthalAngle()),
      polarDeg: degrees(controls.getPolarAngle()),
      zoomFactor: round(zoomFactor),
      distance: round(controls.getDistance()),
      aspect: round(camera.aspect),
      position: {
        x: round(camera.position.x),
        y: round(camera.position.y),
        z: round(camera.position.z),
      },
      target: {
        x: round(controls.target.x),
        y: round(controls.target.y),
        z: round(controls.target.z),
      },
    },
    composition: {
      scale: round(global.scale),
      blockGapFactor: round(global.betweenFactor),
      textAngleDeg: Number(textAngleInput.value),
      align: global.align,
      rowCount: composition.rows.length,
      boxWidth: round(composition.maxWidth, 1),
      boxHeight: round(extent.bottom - extent.top, 1),
    },
    colors: {
      text: textColorInput.value,
      pageBackground: pageBgColorInput.value,
      sphere: SPHERE_COLOR,
      transparentSphere: transparentSphereInput.checked,
    },
    debug: {
      // Preview-only overlay; recorded for completeness, not part of the artwork.
      boundsOverlay: debugBoundsInput.checked,
    },
    blocks: blocksState.map((block, index) => ({
      position: index + 1,
      text: block.text,
      weight: block.weight,
      size: block.size,
      lineFactor: round(block.lineFactor, 2),
    })),
    stage: {
      textureWidth: TEXTURE_WIDTH,
      textureHeight: TEXTURE_HEIGHT,
      sphereRadius: SPHERE_RADIUS,
      viewportWidth: renderer.domElement.width,
      viewportHeight: renderer.domElement.height,
    },
  };
}

function exportSettings() {
  const settings = collectSettings();
  const stamp = settings.exportedAt.slice(0, 19).replaceAll(":", "-");
  const blob = new Blob([JSON.stringify(settings, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  downloadBlob(blob, `sphere-typography-settings-${stamp}.json`);
  setFontsStatus("Настройки выгружены в JSON.");
}

function applySettings(settings) {
  if (settings.format !== "sphere-typography/settings") {
    setFontsStatus("Ошибка: неверный формат файла.");
    return;
  }

  // Blocks
  blockSeq = 0;
  blocksState.length = 0;
  for (const b of settings.blocks ?? []) {
    blocksState.push(makeBlock({ text: b.text, weight: b.weight, size: b.size, lineFactor: b.lineFactor }));
  }

  // Composition
  blockGapInput.value = String(Math.round((settings.composition.blockGapFactor ?? 1.2) * 100));
  textAngleInput.value = String(settings.composition.textAngleDeg ?? 0);
  scaleInput.value = String(Math.round((settings.composition.scale ?? 1) * 100));
  setTextAlign(settings.composition.align ?? "center");

  // Colors
  textColorInput.value = settings.colors.text ?? "#ff6a00";
  pageBgColorInput.value = settings.colors.pageBackground ?? "#080b14";
  transparentSphereInput.checked = !!settings.colors.transparentSphere;

  // Debug overlay
  debugBoundsInput.checked = !!(settings.debug?.boundsOverlay);

  // Camera focal length + zoom
  focalLength = settings.camera.focalLengthMm ?? DEFAULT_FOCAL_LENGTH;
  focalLengthInput.value = String(focalLength);
  zoomFactor = settings.camera.zoomFactor ?? 1;
  applyCameraFraming();

  // Restore orbit position from saved spherical angles
  const azimuth = (settings.camera.azimuthDeg * Math.PI) / 180;
  const polar = (settings.camera.polarDeg * Math.PI) / 180;
  const distance = framedDistance() * zoomFactor;
  controls.target.set(
    settings.camera.target?.x ?? 0,
    settings.camera.target?.y ?? 0,
    settings.camera.target?.z ?? 0,
  );
  camera.position.set(
    controls.target.x + distance * Math.sin(polar) * Math.sin(azimuth),
    controls.target.y + distance * Math.cos(polar),
    controls.target.z + distance * Math.sin(polar) * Math.cos(azimuth),
  );
  controls.update();

  // Update all labels and redraw
  updateBlockGapLabel();
  updateAngleLabel();
  updateScaleLabel();
  updatePageBackground(pageBgColorInput.value);
  renderBlocks();
  applySphereTransparency();
  setFontsStatus("Настройки импортированы.");
}

function importSettings() {
  const input = document.getElementById("import-settings-input");
  input.value = "";
  input.click();
}

document.getElementById("import-settings-input").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const settings = JSON.parse(reader.result);
      applySettings(settings);
    } catch {
      setFontsStatus("Ошибка: не удалось прочитать JSON.");
    }
  });
  reader.readAsText(file);
});

async function saveSvg() {
  if (saveBtn.disabled) return;

  saveBtn.disabled = true;
  const previousLabel = saveBtn.textContent;
  saveBtn.textContent = "Готовлю кривые…";

  try {
    drawTexture();
    controls.update();

    const composition = buildComposition();
    if (composition.rows.length === 0) {
      setFontsStatus("Нет текста для экспорта.");
      return;
    }

    // Load an opentype font for every weight used in the composition.
    const weights = [...new Set(composition.rows.map((row) => row.weight))];
    const loaded = await Promise.all(weights.map((weight) => getExportFont(weight)));
    const fontMap = {};
    weights.forEach((weight, index) => {
      fontMap[weight] = loaded[index].font;
    });

    const contours = getCompositionContours(
      composition.rows,
      fontMap,
      TEXTURE_WIDTH,
      TEXTURE_HEIGHT,
      composition.angleRadians,
      composition.align,
    );

    const svg = buildVectorSvg({
      contours,
      settings: { textColor: composition.textColor },
      camera,
      width: renderer.domElement.width,
      height: renderer.domElement.height,
      textureWidth: TEXTURE_WIDTH,
      textureHeight: TEXTURE_HEIGHT,
      sphereRadius: SPHERE_RADIUS,
    });

    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    downloadBlob(blob, "sphere-text.svg");

    setFontsStatus("SVG сохранён в кривых.");
  } catch (error) {
    console.error(error);
    setFontsStatus(`Не удалось собрать SVG: ${error.message}`);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = previousLabel;
  }
}

// --- Block UI ---------------------------------------------------------------

let draggingId = null;
let dropTarget = null;

function clearDropIndicators() {
  blocksContainer.querySelectorAll(".block").forEach((node) => {
    node.classList.remove("block--drop-before", "block--drop-after");
  });
}

function addBlock() {
  if (blocksState.length >= MAX_BLOCKS) return;
  blocksState.push(makeBlock({ text: "", weight: 700, size: 48, lineFactor: 0.9 }));
  renderBlocks();
  drawTexture();
  const lastText = blocksContainer.lastElementChild?.querySelector(".block__text");
  lastText?.focus();
}

function removeBlock(id) {
  if (blocksState.length <= 1) return;
  const index = blocksState.findIndex((block) => block.id === id);
  if (index < 0) return;
  blocksState.splice(index, 1);
  renderBlocks();
  drawTexture();
}

function applyReorder() {
  if (!draggingId || !dropTarget || draggingId === dropTarget.id) {
    clearDropIndicators();
    return;
  }
  const from = blocksState.findIndex((block) => block.id === draggingId);
  if (from < 0) return;

  const [moved] = blocksState.splice(from, 1);
  const targetIndex = blocksState.findIndex((block) => block.id === dropTarget.id);
  const insertAt = dropTarget.after ? targetIndex + 1 : targetIndex;
  blocksState.splice(insertAt, 0, moved);

  draggingId = null;
  dropTarget = null;
  renderBlocks();
  drawTexture();
}

function renderBlocks() {
  blocksContainer.replaceChildren();

  blocksState.forEach((block, index) => {
    const node = blockTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = block.id;
    node.querySelector(".block__title").textContent = `Строка ${index + 1}`;

    const del = node.querySelector(".block__delete");
    if (index === 0) {
      del.remove(); // the first block is the base and can't be deleted
    } else {
      del.addEventListener("click", () => removeBlock(block.id));
    }

    const textarea = node.querySelector(".block__text");
    textarea.value = block.text;
    textarea.addEventListener("input", () => {
      block.text = textarea.value;
      drawTexture();
    });

    const weightSelect = node.querySelector(".block__weight");
    weightSelect.value = String(block.weight);
    weightSelect.addEventListener("change", () => {
      block.weight = Number(weightSelect.value);
      drawTexture();
    });

    const sizeInput = node.querySelector(".block__size");
    sizeInput.value = String(block.size);
    sizeInput.addEventListener("input", () => {
      const value = parseInt(sizeInput.value, 10);
      if (Number.isFinite(value) && value > 0) {
        block.size = Math.min(2000, value);
        drawTexture();
      }
    });

    const lineInput = node.querySelector(".block__linefactor");
    const lineValue = node.querySelector(".block__linefactor-value");
    lineInput.value = String(Math.round(block.lineFactor * 100));
    lineValue.textContent = `${block.lineFactor.toFixed(2)}×`;
    lineInput.addEventListener("input", () => {
      block.lineFactor = Number(lineInput.value) / 100;
      lineValue.textContent = `${block.lineFactor.toFixed(2)}×`;
      drawTexture();
    });

    // Drag & drop reordering (from the handle only, so textarea stays usable).
    const handle = node.querySelector(".block__handle");
    handle.setAttribute("draggable", "true");
    handle.addEventListener("dragstart", (event) => {
      draggingId = block.id;
      node.classList.add("block--dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", block.id);
    });
    handle.addEventListener("dragend", () => {
      draggingId = null;
      node.classList.remove("block--dragging");
      clearDropIndicators();
    });
    node.addEventListener("dragover", (event) => {
      if (!draggingId || draggingId === block.id) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const after = event.clientY - rect.top > rect.height / 2;
      clearDropIndicators();
      node.classList.add(after ? "block--drop-after" : "block--drop-before");
      dropTarget = { id: block.id, after };
    });
    node.addEventListener("drop", (event) => {
      if (!draggingId) return;
      event.preventDefault();
      applyReorder();
    });

    blocksContainer.append(node);
  });

  addBlockBtn.style.display = blocksState.length >= MAX_BLOCKS ? "none" : "";
}

// --- Rendering loop & misc --------------------------------------------------

function resize() {
  const element = canvas.parentElement;
  const width = element.clientWidth;
  const height = element.clientHeight;
  camera.aspect = width / height;
  applyCameraFraming(); // aspect feeds into the film height, so re-derive the FOV
  renderer.setSize(width, height, false);
}

function animate() {
  controls.update();
  // Track manual zoom so it is preserved across lens changes and resizes. This
  // is idempotent for our own dollying, which sets exactly framed * zoomFactor.
  zoomFactor = controls.getDistance() / framedDistance();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function updateBlockGapLabel() {
  blockGapValue.textContent = `${(Number(blockGapInput.value) / 100).toFixed(2)}×`;
}

function updateAngleLabel() {
  const value = Number(textAngleInput.value);
  textAngleValue.textContent = `${value > 0 ? "+" : ""}${value}°`;
}

function updateScaleLabel() {
  scaleValue.textContent = `${scaleInput.value}%`;
}

async function loadPreviewFont() {
  setFontsStatus("Загружаю шрифт…");
  try {
    await Promise.all(
      Object.entries(FONT_URLS).map(async ([weight, url]) => {
        const face = new FontFace(FONT_FAMILY, `url("${url}")`, { weight: String(weight) });
        await face.load();
        document.fonts.add(face);
      }),
    );
    setFontsStatus(`Шрифт «${FONT_FAMILY}» готов.`);
  } catch (error) {
    console.error(error);
    setFontsStatus(`Не удалось загрузить шрифт «${FONT_FAMILY}».`);
  }
}

// --- Wiring -----------------------------------------------------------------

/**
 * Debug mode reveals the controls kept out of the public panel (scale, font
 * weight, focal length, the bounds overlay and the settings export). Values set
 * there survive leaving the mode — that is the point of dialling a look in and
 * then presenting it.
 */
function setDebugMode(enabled) {
  document.body.classList.toggle("is-debug", enabled);
  debugToggleBtn.setAttribute("aria-pressed", String(enabled));
  debugToggleBtn.setAttribute(
    "aria-label",
    enabled ? "Выйти из режима отладки" : "Режим отладки",
  );

  // The bounds overlay is the exception: it is scaffolding, not a look. Leaving
  // it painted on the sphere with no visible control to clear it would strand
  // the user outside debug mode.
  if (!enabled && debugBoundsInput.checked) {
    debugBoundsInput.checked = false;
    drawTexture();
  }
}

function setTextAlign(next) {
  textAlign = next;
  for (const button of alignButtons) {
    const active = button.dataset.align === next;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  }
  drawTexture();
}

addBlockBtn.addEventListener("click", addBlock);
for (const button of alignButtons) {
  button.addEventListener("click", () => setTextAlign(button.dataset.align));
}
debugBoundsInput.addEventListener("change", drawTexture);
debugToggleBtn.addEventListener("click", () => {
  setDebugMode(!document.body.classList.contains("is-debug"));
});
transparentSphereInput.addEventListener("change", applySphereTransparency);
textColorInput.addEventListener("input", drawTexture);
pageBgColorInput.addEventListener("input", () => updatePageBackground(pageBgColorInput.value));
blockGapInput.addEventListener("input", () => {
  updateBlockGapLabel();
  drawTexture();
});
textAngleInput.addEventListener("input", () => {
  updateAngleLabel();
  drawTexture();
});
scaleInput.addEventListener("input", () => {
  updateScaleLabel();
  drawTexture();
});
// While typing, only react to values already inside the range, so a half-typed
// "1" on the way to "150" is not clamped to the minimum. `change` (blur, Enter,
// spinner) settles whatever is left in the field.
focalLengthInput.addEventListener("input", () => {
  const value = Number(focalLengthInput.value);
  if (Number.isFinite(value) && value >= MIN_FOCAL_LENGTH && value <= MAX_FOCAL_LENGTH) {
    updateFocalLength(value);
  }
});
focalLengthInput.addEventListener("change", () => {
  const value = Number(focalLengthInput.value);
  updateFocalLength(Number.isFinite(value) && value > 0 ? value : DEFAULT_FOCAL_LENGTH);
  focalLengthInput.value = String(focalLength);
});
saveBtn.addEventListener("click", saveSvg);
exportSettingsBtn.addEventListener("click", exportSettings);
importSettingsBtn.addEventListener("click", importSettings);
window.addEventListener("resize", resize);

focalLengthInput.min = String(MIN_FOCAL_LENGTH);
focalLengthInput.max = String(MAX_FOCAL_LENGTH);
focalLengthInput.value = String(DEFAULT_FOCAL_LENGTH);
setDebugMode(false);
setTextAlign(textAlign);
updateBlockGapLabel();
updateAngleLabel();
updateScaleLabel();
updatePageBackground(pageBgColorInput.value);
renderBlocks();

loadPreviewFont().finally(() => {
  applySphereTransparency();
  resize();
  animate();
});
