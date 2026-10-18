const degreesToRadians = Math.PI / 180;

export const gargantuaAzimuthRadians = 0;
export const gargantuaElevationRadians = 18 * degreesToRadians;
export const openingYawRadians = -8 * degreesToRadians;

export function directionFromAzimuthElevation(azimuthRadians, elevationRadians, target) {
    const cosineElevation = Math.cos(elevationRadians);
    target[0] = Math.sin(azimuthRadians) * cosineElevation;
    target[1] = Math.sin(elevationRadians);
    target[2] = Math.cos(azimuthRadians) * cosineElevation;
    return target;
}
