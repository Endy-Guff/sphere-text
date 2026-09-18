import * as opentype from "opentype";

// The bundled brand font, one file per weight. Both the live preview (via the
// FontFace API in main.js) and the SVG export (via opentype.js here) use these
// exact same files, so the exported curves always match the sphere.
const FONT_URLS = {
  400: "./fonts/ALSChromius-Regular.otf",
  700: "./fonts/ALSChromius-Bold.otf",
};
export const FONT_FAMILY = "ALS Chromius";

const fontPromises = new Map();

/**
 * Load and parse the bundled font for the given weight (400 or 700), once.
 * Returns { font, family } where `font` is an opentype.Font whose glyph
 * outlines drive the SVG export.
 */
export function getExportFont(weight = 400) {
  const url = FONT_URLS[weight] ?? FONT_URLS[400];
  if (!fontPromises.has(url)) {
    const promise = (async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Не удалось загрузить шрифт: ${url}`);
      }
      const buffer = await response.arrayBuffer();
      const font = opentype.parse(buffer);
      return { font, family: FONT_FAMILY };
    })().catch((error) => {
      // Reset so a later retry can attempt the load again.
      fontPromises.delete(url);
      throw error;
    });
    fontPromises.set(url, promise);
  }
  return fontPromises.get(url);
}

// --- Bézier flattening -------------------------------------------------------

function quadPoint(p0, p1, p2, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
  };
}

function cubicPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
    y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
  };
}

function chord(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Pixels of arc per straight segment. Smaller = smoother curves once warped
// onto the sphere, at the cost of more points in the SVG.
const FLATNESS_PX = 2.2;

function segmentsForCurve(approxLength) {
  return Math.min(64, Math.max(3, Math.ceil(approxLength / FLATNESS_PX)));
}

/**
 * Turn the placed glyph outline of one text line into closed contours of
 * { texX, texY } points in texture-pixel space. `place(px, py)` maps a point in
 * the line's local baseline space to texture coordinates (handles centering,
 * vertical middle alignment, rotation and offset — i.e. exactly what the live
 * preview does on the 2D canvas).
 */
function commandsToContours(commands, place) {
  const contours = [];
  let current = null;
  let pen = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };

  const closeCurrent = () => {
    if (current && current.points.length > 1) {
      contours.push(current);
    }
    current = null;
  };

  for (const cmd of commands) {
    if (cmd.type === "M") {
      closeCurrent();
      current = { points: [place(cmd.x, cmd.y)], closed: false };
      pen = { x: cmd.x, y: cmd.y };
      start = { x: cmd.x, y: cmd.y };
    } else if (cmd.type === "L") {
      if (!current) continue;
      current.points.push(place(cmd.x, cmd.y));
      pen = { x: cmd.x, y: cmd.y };
    } else if (cmd.type === "Q") {
      if (!current) continue;
      const p0 = pen;
      const p1 = { x: cmd.x1, y: cmd.y1 };
      const p2 = { x: cmd.x, y: cmd.y };
      const steps = segmentsForCurve(chord(p0, p1) + chord(p1, p2));
      for (let i = 1; i <= steps; i += 1) {
        const point = quadPoint(p0, p1, p2, i / steps);
        current.points.push(place(point.x, point.y));
      }
      pen = p2;
    } else if (cmd.type === "C") {
      if (!current) continue;
      const p0 = pen;
      const p1 = { x: cmd.x1, y: cmd.y1 };
      const p2 = { x: cmd.x2, y: cmd.y2 };
      const p3 = { x: cmd.x, y: cmd.y };
      const steps = segmentsForCurve(chord(p0, p1) + chord(p1, p2) + chord(p2, p3));
      for (let i = 1; i <= steps; i += 1) {
        const point = cubicPoint(p0, p1, p2, p3, i / steps);
        current.points.push(place(point.x, point.y));
      }
      pen = p3;
    } else if (cmd.type === "Z") {
      if (current) {
        current.closed = true;
        contours.push(current);
        current = null;
      }
      pen = { x: start.x, y: start.y };
    }
  }

  closeCurrent();
  return contours;
}

/**
 * Build outline contours for a whole composition in texture-pixel space,
 * reproducing the live preview's layout. `rows` is a flat, pre-wrapped and
 * pre-positioned list produced by main.js:
 *   { text, weight, sizePx, centerY }  // centerY = row's vertical centre
 *                                       // relative to the texture centre
 * `fontMap` maps a weight (400/700) to a parsed opentype.Font. Alignment,
 * middle-baseline emulation and global rotation are applied here.
 *
 * `align` is "center" (each row centred on its own) or "left" (all rows flush to
 * the composition box's left edge), matching what the preview draws on canvas.
 */
export function getCompositionContours(
  rows,
  fontMap,
  textureWidth,
  textureHeight,
  angleRadians,
  align = "center",
) {
  const cos = Math.cos(angleRadians);
  const sin = Math.sin(angleRadians);
  const centerX = textureWidth / 2;
  const centerY = textureHeight / 2;

  const fontFor = (row) => fontMap[row.weight] || fontMap[400] || Object.values(fontMap)[0];

  // Left alignment needs the box's left edge, so every row has to be measured up
  // front — with the same opentype metrics that place the glyphs below.
  let maxWidth = 0;
  if (align === "left") {
    for (const row of rows) {
      const font = row.text ? fontFor(row) : null;
      if (!font) continue;
      maxWidth = Math.max(maxWidth, font.getAdvanceWidth(row.text, row.sizePx));
    }
  }

  const allContours = [];

  for (const row of rows) {
    if (!row.text) continue;
    const font = fontFor(row);
    if (!font) continue;

    // Canvas `textBaseline = "middle"` centres on the em box. Reproduce that by
    // shifting the baseline down by (ascender + descender) / 2.
    const glyphScale = row.sizePx / font.unitsPerEm;
    const middleOffset = ((font.ascender + font.descender) / 2) * glyphScale;
    const lineWidth = font.getAdvanceWidth(row.text, row.sizePx);
    const path = font.getPath(row.text, 0, 0, row.sizePx);

    const originX = align === "left" ? -maxWidth / 2 : -lineWidth / 2;

    const place = (px, py) => {
      // Local space: x aligned inside the box, y measured from the row centre.
      const localX = px + originX;
      const localY = row.centerY + middleOffset + py;
      // Apply the same rotation + translation the preview applies on canvas.
      return {
        texX: centerX + localX * cos - localY * sin,
        texY: centerY + localX * sin + localY * cos,
      };
    };

    const contours = commandsToContours(path.commands, place);
    for (const contour of contours) {
      allContours.push(contour);
    }
  }

  return allContours;
}
