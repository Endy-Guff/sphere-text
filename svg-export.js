import * as THREE from "three";

// --- geometry helpers (pure, no three.js — so they can be unit-tested) -------

// Texture (u,v) -> point on the sphere surface. This MUST match the mapping the
// live preview relies on (three.js SphereGeometry UVs + the CanvasTexture), so
// the exported vector reproduces exactly what is drawn on screen.
export function texToSphere(texX, texY, textureWidth, textureHeight, radius) {
  const u = texX / textureWidth;
  const v = texY / textureHeight;
  const theta = u * Math.PI * 2;
  const phi = v * Math.PI;
  const sinPhi = Math.sin(phi);

  return {
    x: -radius * sinPhi * Math.cos(theta),
    y: radius * Math.cos(phi),
    z: radius * sinPhi * Math.sin(theta),
  };
}

function normalize(p) {
  const length = Math.hypot(p.x, p.y, p.z) || 1;
  return { x: p.x / length, y: p.y / length, z: p.z / length };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const FRONT_FACE_EPSILON = 0.02;

/**
 * Core, three.js-free vector builder.
 *
 * For every contour point: texture -> 3D sphere point -> screen projection.
 * Because each vertex is projected independently through the non-linear sphere
 * mapping, the glyph outlines genuinely bend around the sphere instead of being
 * sheared as flat sprites (which is what the old `<text transform="matrix()">`
 * export produced). Points whose surface normal faces away from the camera are
 * culled, and contours are split into visible runs at the silhouette.
 *
 * @param {(p:{x,y,z}) => {x:number,y:number,depth:number}} project
 * @param {{x:number,y:number,z:number}} cameraPosition
 */
export function warpContoursToSvg({
  contours,
  settings,
  project,
  cameraPosition,
  width,
  height,
  textureWidth,
  textureHeight,
  sphereRadius,
}) {
  const subpaths = [];

  for (const contour of contours) {
    const mapped = contour.points.map((point) => {
      const surface = texToSphere(point.texX, point.texY, textureWidth, textureHeight, sphereRadius);
      const normal = normalize(surface);
      const view = normalize({
        x: cameraPosition.x - surface.x,
        y: cameraPosition.y - surface.y,
        z: cameraPosition.z - surface.z,
      });
      const screen = project(surface);
      const visible =
        dot(normal, view) > FRONT_FACE_EPSILON && screen.depth >= -1 && screen.depth <= 1;
      return { x: screen.x, y: screen.y, visible };
    });

    const allVisible = mapped.every((p) => p.visible);

    if (allVisible && contour.closed) {
      subpaths.push({ points: mapped, closed: true });
      continue;
    }

    // Split into maximal runs of consecutive visible points.
    let run = [];
    const flushRun = () => {
      if (run.length > 1) {
        subpaths.push({ points: run, closed: false });
      }
      run = [];
    };

    for (const point of mapped) {
      if (point.visible) {
        run.push(point);
      } else {
        flushRun();
      }
    }
    flushRun();
  }

  const d = subpaths
    .map((subpath) => {
      const commands = subpath.points
        .map((point, index) => {
          const x = point.x.toFixed(2);
          const y = point.y.toFixed(2);
          return `${index === 0 ? "M" : "L"}${x} ${y}`;
        })
        .join(" ");
      return subpath.closed ? `${commands} Z` : commands;
    })
    .join(" ");

  const fill = escapeXml(settings.textColor);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <path fill="${fill}" fill-rule="nonzero" d="${d}"/>
</svg>`;
}

/**
 * Browser entry point: wraps three.js camera projection into the pure builder.
 */
export function buildVectorSvg({
  contours,
  settings,
  camera,
  width,
  height,
  textureWidth,
  textureHeight,
  sphereRadius,
}) {
  const scratch = new THREE.Vector3();
  const project = (surface) => {
    scratch.set(surface.x, surface.y, surface.z).project(camera);
    return {
      x: (scratch.x * 0.5 + 0.5) * width,
      y: (-scratch.y * 0.5 + 0.5) * height,
      depth: scratch.z,
    };
  };

  return warpContoursToSvg({
    contours,
    settings,
    project,
    cameraPosition: {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
    },
    width,
    height,
    textureWidth,
    textureHeight,
    sphereRadius,
  });
}
