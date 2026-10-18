/*
 * Derived from snowflow_demo by Maksymilian Dendura (Noniv): https://github.com/Noniv/snowflow_demo
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

export function setFrame(out, offset, positionX, positionY, positionZ, xAxisX, xAxisY, xAxisZ, yAxisX, yAxisY, yAxisZ, zAxisX, zAxisY, zAxisZ) {
    out[offset] = xAxisX;
    out[offset + 1] = xAxisY;
    out[offset + 2] = xAxisZ;
    out[offset + 3] = 0;
    out[offset + 4] = yAxisX;
    out[offset + 5] = yAxisY;
    out[offset + 6] = yAxisZ;
    out[offset + 7] = 0;
    out[offset + 8] = zAxisX;
    out[offset + 9] = zAxisY;
    out[offset + 10] = zAxisZ;
    out[offset + 11] = 0;
    out[offset + 12] = positionX;
    out[offset + 13] = positionY;
    out[offset + 14] = positionZ;
    out[offset + 15] = 1;
}

export function setFrameFromDirection(out, offset, positionX, positionY, positionZ, directionX, directionY, directionZ, referenceX, referenceY, referenceZ) {
    let length = Math.hypot(directionX, directionY, directionZ) || 1;
    const yAxisX = directionX / length;
    const yAxisY = directionY / length;
    const yAxisZ = directionZ / length;
    let xAxisX = yAxisY * referenceZ - yAxisZ * referenceY;
    let xAxisY = yAxisZ * referenceX - yAxisX * referenceZ;
    let xAxisZ = yAxisX * referenceY - yAxisY * referenceX;
    length = Math.hypot(xAxisX, xAxisY, xAxisZ);
    if (length < 1e-5) {
        xAxisX = 0;
        xAxisY = yAxisZ;
        xAxisZ = -yAxisY;
        length = Math.hypot(xAxisX, xAxisY, xAxisZ) || 1;
    }
    xAxisX /= length;
    xAxisY /= length;
    xAxisZ /= length;
    setFrame(
        out, offset, positionX, positionY, positionZ,
        xAxisX, xAxisY, xAxisZ,
        yAxisX, yAxisY, yAxisZ,
        xAxisY * yAxisZ - xAxisZ * yAxisY, xAxisZ * yAxisX - xAxisX * yAxisZ, xAxisX * yAxisY - xAxisY * yAxisX,
    );
}

export function multiplyRigid(out, outOffset, left, leftOffset, right, rightOffset) {
    for (let column = 0; column < 4; column++) {
        const x = right[rightOffset + column * 4];
        const y = right[rightOffset + column * 4 + 1];
        const z = right[rightOffset + column * 4 + 2];
        const w = right[rightOffset + column * 4 + 3];
        out[outOffset + column * 4] = left[leftOffset] * x + left[leftOffset + 4] * y + left[leftOffset + 8] * z + left[leftOffset + 12] * w;
        out[outOffset + column * 4 + 1] = left[leftOffset + 1] * x + left[leftOffset + 5] * y + left[leftOffset + 9] * z + left[leftOffset + 13] * w;
        out[outOffset + column * 4 + 2] = left[leftOffset + 2] * x + left[leftOffset + 6] * y + left[leftOffset + 10] * z + left[leftOffset + 14] * w;
        out[outOffset + column * 4 + 3] = left[leftOffset + 3] * x + left[leftOffset + 7] * y + left[leftOffset + 11] * z + left[leftOffset + 15] * w;
    }
}

export function invertRigid(out, outOffset, matrix, matrixOffset) {
    const xAxisX = matrix[matrixOffset];
    const xAxisY = matrix[matrixOffset + 1];
    const xAxisZ = matrix[matrixOffset + 2];
    const yAxisX = matrix[matrixOffset + 4];
    const yAxisY = matrix[matrixOffset + 5];
    const yAxisZ = matrix[matrixOffset + 6];
    const zAxisX = matrix[matrixOffset + 8];
    const zAxisY = matrix[matrixOffset + 9];
    const zAxisZ = matrix[matrixOffset + 10];
    const translationX = matrix[matrixOffset + 12];
    const translationY = matrix[matrixOffset + 13];
    const translationZ = matrix[matrixOffset + 14];
    out[outOffset] = xAxisX;
    out[outOffset + 1] = yAxisX;
    out[outOffset + 2] = zAxisX;
    out[outOffset + 3] = 0;
    out[outOffset + 4] = xAxisY;
    out[outOffset + 5] = yAxisY;
    out[outOffset + 6] = zAxisY;
    out[outOffset + 7] = 0;
    out[outOffset + 8] = xAxisZ;
    out[outOffset + 9] = yAxisZ;
    out[outOffset + 10] = zAxisZ;
    out[outOffset + 11] = 0;
    out[outOffset + 12] = -(xAxisX * translationX + xAxisY * translationY + xAxisZ * translationZ);
    out[outOffset + 13] = -(yAxisX * translationX + yAxisY * translationY + yAxisZ * translationZ);
    out[outOffset + 14] = -(zAxisX * translationX + zAxisY * translationY + zAxisZ * translationZ);
    out[outOffset + 15] = 1;
}

export function transformPoint(matrix, matrixOffset, x, y, z, destination, destinationOffset) {
    destination[destinationOffset] = matrix[matrixOffset] * x + matrix[matrixOffset + 4] * y + matrix[matrixOffset + 8] * z + matrix[matrixOffset + 12];
    destination[destinationOffset + 1] = matrix[matrixOffset + 1] * x + matrix[matrixOffset + 5] * y + matrix[matrixOffset + 9] * z + matrix[matrixOffset + 13];
    destination[destinationOffset + 2] = matrix[matrixOffset + 2] * x + matrix[matrixOffset + 6] * y + matrix[matrixOffset + 10] * z + matrix[matrixOffset + 14];
}

export function transformDirection(matrix, matrixOffset, x, y, z, destination, destinationOffset) {
    destination[destinationOffset] = matrix[matrixOffset] * x + matrix[matrixOffset + 4] * y + matrix[matrixOffset + 8] * z;
    destination[destinationOffset + 1] = matrix[matrixOffset + 1] * x + matrix[matrixOffset + 5] * y + matrix[matrixOffset + 9] * z;
    destination[destinationOffset + 2] = matrix[matrixOffset + 2] * x + matrix[matrixOffset + 6] * y + matrix[matrixOffset + 10] * z;
}
