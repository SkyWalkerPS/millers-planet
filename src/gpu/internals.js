import { WebGPUCacheRenderPipeline } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipeline";

export function getGpuDevice(engine) {
    return engine._device;
}

export function getFrameRenderEncoder(engine) {
    return engine._renderEncoder;
}

export function getTimestampQueryHooks(engine) {
    return engine._timestampQuery;
}

export function getCurrentRenderTargetWrapper(engine) {
    return engine._currentRenderTarget;
}

export function endOpenRenderPass(engine) {
    engine._endCurrentRenderPass();
}

export function hasOpenRenderPass(engine) {
    return Boolean(engine._currentRenderPass);
}

export function discardCanvasDepthAfterEachPass(engine) {
    const mainPassDescriptor = engine._mainRenderPassWrapper?.renderPassDescriptor;
    if (mainPassDescriptor?.depthStencilAttachment) {
        mainPassDescriptor.depthStencilAttachment.depthStoreOp = "discard";
    }
}

export function getGpuTextureOfInternalTexture(internalTexture) {
    return internalTexture?._hardwareTexture?.underlyingResource ?? null;
}

export function getGpuBufferOfStorageBuffer(storageBuffer) {
    return storageBuffer.getBuffer().underlyingResource;
}

export function readRenderPipelinesCreatedLastFrame() {
    return WebGPUCacheRenderPipeline.NumPipelineCreationLastFrame ?? 0;
}

export function installPipelineCreationCounters(device) {
    const counters = { renderPipelinesCreated: 0, computePipelinesCreated: 0 };
    const originalCreateRenderPipeline = device.createRenderPipeline.bind(device);
    const originalCreateRenderPipelineAsync = device.createRenderPipelineAsync.bind(device);
    const originalCreateComputePipeline = device.createComputePipeline.bind(device);
    const originalCreateComputePipelineAsync = device.createComputePipelineAsync.bind(device);
    device.createRenderPipeline = (descriptor) => {
        counters.renderPipelinesCreated++;
        return originalCreateRenderPipeline(descriptor);
    };
    device.createRenderPipelineAsync = (descriptor) => {
        counters.renderPipelinesCreated++;
        return originalCreateRenderPipelineAsync(descriptor);
    };
    device.createComputePipeline = (descriptor) => {
        counters.computePipelinesCreated++;
        return originalCreateComputePipeline(descriptor);
    };
    device.createComputePipelineAsync = (descriptor) => {
        counters.computePipelinesCreated++;
        return originalCreateComputePipelineAsync(descriptor);
    };
    return counters;
}
