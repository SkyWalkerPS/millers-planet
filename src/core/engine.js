import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine.pure";
import "@babylonjs/core/ShadersWGSL/clearQuad.vertex";
import "@babylonjs/core/ShadersWGSL/clearQuad.fragment";
import "@babylonjs/core/Buffers/buffer.align";
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.dom";
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.states";
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.stencil";
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.renderPass";
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.texture";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.alpha";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.readTexture";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.renderTarget";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.renderTargetTexture";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.query";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";

export const requiredDeviceFeatures = ["timestamp-query", "float32-filterable", "shader-f16"];
const optionalDeviceFeatures = ["rg11b10ufloat-renderable"];

export class WebGpuUnavailableError extends Error {}

export async function createEngine(canvas) {
    if (!navigator.gpu) {
        throw new WebGpuUnavailableError("navigator.gpu is missing");
    }
    const adapterProbe = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapterProbe) {
        throw new WebGpuUnavailableError("no WebGPU adapter");
    }
    const engine = new WebGPUEngine(canvas, {
        antialias: false,
        stencil: false,
        powerPreference: "high-performance",
        adaptToDeviceRatio: true,
        setMaximumLimits: true,
        deviceDescriptor: { requiredFeatures: [...requiredDeviceFeatures, ...optionalDeviceFeatures] },
    });
    try {
        await engine.initAsync();
    } catch (initialisationError) {
        throw new WebGpuUnavailableError(String(initialisationError?.message ?? initialisationError));
    }
    engine.enableGPUTimingMeasurements = true;
    engine.useReverseDepthBuffer = true;
    const enabledFeatureNames = engine.enabledExtensions.slice();
    const missingRequiredFeatures = requiredDeviceFeatures.filter((featureName) => !enabledFeatureNames.includes(featureName));
    const adapterInformation = adapterProbe.info ?? {};
    return {
        engine,
        enabledFeatureNames,
        missingRequiredFeatures,
        adapter: { vendor: adapterInformation.vendor ?? "", architecture: adapterInformation.architecture ?? "" },
    };
}

export function showWebGpuMissingLine() {
    const messageElement = document.getElementById("webgpu-missing");
    if (messageElement) {
        messageElement.style.display = "block";
    }
    const canvas = document.getElementById("scene");
    if (canvas) {
        canvas.style.display = "none";
    }
}
