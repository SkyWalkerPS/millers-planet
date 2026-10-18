const AERIAL_PERSPECTIVE_SIZE: u32 = 32u;
const AERIAL_PERSPECTIVE_FAR_KILOMETRES: f32 = 32.0;

fn aerialPerspectiveSliceCoordinate(viewDistanceMetres: f32) -> f32 {
    let normalised = sqrt(clamp(viewDistanceMetres * 0.001 / AERIAL_PERSPECTIVE_FAR_KILOMETRES, 0.0, 1.0));
    return clamp(normalised - 0.5 / f32(AERIAL_PERSPECTIVE_SIZE), 0.5 / f32(AERIAL_PERSPECTIVE_SIZE), 1.0 - 0.5 / f32(AERIAL_PERSPECTIVE_SIZE));
}
