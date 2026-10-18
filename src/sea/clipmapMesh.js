/*
 * Derived from snowflow_demo by Maksymilian Dendura (Noniv): https://github.com/Noniv/snowflow_demo
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";

export const clipmapQuadsPerSide = 128;
export const clipmapRingCount = 12;
export const clipmapBaseSpacingMetres = 0.05;
const holeShrinkCells = 3;
const halfQuadsPerSide = clipmapQuadsPerSide / 2;

export const clipmapOuterHalfExtentMetres = halfQuadsPerSide * clipmapBaseSpacingMetres * 2 ** (clipmapRingCount - 1);

export function buildClipmapMesh(name, scene) {
    const side = clipmapQuadsPerSide + 1;
    const verticesPerRing = side * side;
    const positions = new Float32Array(verticesPerRing * clipmapRingCount * 3);
    const holeHalf = halfQuadsPerSide / 2 - holeShrinkCells;
    const holeQuads = holeHalf * 2 * (holeHalf * 2);
    const quadCount = clipmapQuadsPerSide * clipmapQuadsPerSide + (clipmapRingCount - 1) * (clipmapQuadsPerSide * clipmapQuadsPerSide - holeQuads);
    const indices = new Uint32Array(quadCount * 6);
    let vertexCursor = 0;
    let indexCursor = 0;
    for (let ring = 0; ring < clipmapRingCount; ring++) {
        const ringBase = ring * verticesPerRing;
        for (let row = 0; row <= clipmapQuadsPerSide; row++) {
            for (let column = 0; column <= clipmapQuadsPerSide; column++) {
                positions[vertexCursor++] = column - halfQuadsPerSide;
                positions[vertexCursor++] = ring;
                positions[vertexCursor++] = row - halfQuadsPerSide;
            }
        }
        for (let row = 0; row < clipmapQuadsPerSide; row++) {
            const gridRow = row - halfQuadsPerSide;
            for (let column = 0; column < clipmapQuadsPerSide; column++) {
                const gridColumn = column - halfQuadsPerSide;
                if (ring > 0) {
                    const largestCorner = Math.max(Math.abs(gridColumn), Math.abs(gridColumn + 1), Math.abs(gridRow), Math.abs(gridRow + 1));
                    if (largestCorner <= holeHalf) {
                        continue;
                    }
                }
                const corner = ringBase + row * side + column;
                const right = corner + 1;
                const above = corner + side;
                const aboveRight = above + 1;
                if (((column + row) & 1) === 0) {
                    indices[indexCursor++] = corner;
                    indices[indexCursor++] = right;
                    indices[indexCursor++] = above;
                    indices[indexCursor++] = right;
                    indices[indexCursor++] = aboveRight;
                    indices[indexCursor++] = above;
                } else {
                    indices[indexCursor++] = corner;
                    indices[indexCursor++] = aboveRight;
                    indices[indexCursor++] = above;
                    indices[indexCursor++] = corner;
                    indices[indexCursor++] = right;
                    indices[indexCursor++] = aboveRight;
                }
            }
        }
    }
    const mesh = new Mesh(name, scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indexCursor === indices.length ? indices : indices.subarray(0, indexCursor);
    vertexData.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.triangleCount = indexCursor / 3;
    return mesh;
}
