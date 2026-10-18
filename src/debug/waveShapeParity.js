import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { waveLocalShapeAt } from "../wave/waveLocalShape.js";

const invocationsPerWorkgroup = 64;

export async function measureWaveShapeParity(app, lateralMetres) {
    const engine = app.engine;
    const count = Math.ceil(lateralMetres.length / invocationsPerWorkgroup) * invocationsPerWorkgroup;
    const lateralValues = new Float32Array(count);
    lateralValues.set(lateralMetres);
    const inputs = new StorageBuffer(engine, count * 4, Constants.BUFFER_CREATIONFLAG_READWRITE, "waveShapeParityLaterals");
    const outputs = new StorageBuffer(engine, count * 8, Constants.BUFFER_CREATIONFLAG_READWRITE, "waveShapeParityShapes");
    inputs.update(lateralValues);
    const shader = new ComputeShader("waveShapeParity", engine, "waveShapeParity", {
        bindingsMapping: { lateralMetres: { group: 0, binding: 0 }, localShapes: { group: 0, binding: 1 } },
    });
    shader.setStorageBuffer("lateralMetres", inputs);
    shader.setStorageBuffer("localShapes", outputs);
    const errorsBefore = app.gpuErrors.totalErrorCount;
    let attempts = 0;
    while (!shader.isReady() && attempts++ < 200) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const observer = app.scene.onBeforeRenderObservable.add(() => shader.dispatch(count / invocationsPerWorkgroup, 1, 1));
    try {
        await app.renderFramesNow(2);
    } finally {
        app.scene.onBeforeRenderObservable.remove(observer);
    }
    const bytes = await outputs.read();
    const gpuShapes = new Float32Array(bytes.buffer, bytes.byteOffset, count * 2);
    inputs.dispose();
    outputs.dispose();
    const cpuShape = {};
    let largestCrestOffsetErrorMetres = 0;
    let largestHeightScaleError = 0;
    let worstLateralMetres = null;
    let largestCrestOffsetMetres = 0;
    for (let index = 0; index < lateralMetres.length; index++) {
        waveLocalShapeAt(lateralValues[index], cpuShape);
        const heightScaleError = Math.abs(cpuShape.heightScale - gpuShapes[index * 2]);
        const crestOffsetError = Math.abs(cpuShape.crestOffsetMetres - gpuShapes[index * 2 + 1]);
        largestHeightScaleError = Math.max(largestHeightScaleError, heightScaleError);
        if (crestOffsetError > largestCrestOffsetErrorMetres) {
            largestCrestOffsetErrorMetres = crestOffsetError;
            worstLateralMetres = lateralValues[index];
        }
        largestCrestOffsetMetres = Math.max(largestCrestOffsetMetres, Math.abs(gpuShapes[index * 2 + 1]));
    }
    return {
        samples: lateralMetres.length,
        largestCrestOffsetErrorMetres,
        largestHeightScaleError,
        worstLateralMetres,
        largestCrestOffsetMetres,
        gpuErrors: app.gpuErrors.totalErrorCount - errorsBefore,
    };
}
