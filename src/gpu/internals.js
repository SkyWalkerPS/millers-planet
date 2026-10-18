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
    const counters = { renderPipelinesCreated: 0, computePipelinesCreated: 0, recentRenderPipelines: [] };
    const describe = (descriptor) => ({
        label: descriptor.label ?? null,
        vertex: descriptor.vertex?.module?.label ?? null,
        fragment: descriptor.fragment?.module?.label ?? null,
        targets: (descriptor.fragment?.targets ?? []).map((target) => `${target.format}${target.blend ? "+blend" : ""}`),
        depth: descriptor.depthStencil ? `${descriptor.depthStencil.format} ${descriptor.depthStencil.depthCompare} write ${descriptor.depthStencil.depthWriteEnabled}` : null,
        cull: descriptor.primitive?.cullMode ?? null,
    });
    const remember = (descriptor) => {
        counters.recentRenderPipelines.push(describe(descriptor));
        if (counters.recentRenderPipelines.length > 12) {
            counters.recentRenderPipelines.shift();
        }
    };
    const originalCreateRenderPipeline = device.createRenderPipeline.bind(device);
    const originalCreateRenderPipelineAsync = device.createRenderPipelineAsync.bind(device);
    const originalCreateComputePipeline = device.createComputePipeline.bind(device);
    const originalCreateComputePipelineAsync = device.createComputePipelineAsync.bind(device);
    device.createRenderPipeline = (descriptor) => {
        counters.renderPipelinesCreated++;
        remember(descriptor);
        return originalCreateRenderPipeline(descriptor);
    };
    device.createRenderPipelineAsync = (descriptor) => {
        counters.renderPipelinesCreated++;
        remember(descriptor);
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

export function createSingleMipViews(texture, layerCount, dimension = "2d-array") {
    const gpuTexture = getGpuTextureOfInternalTexture(texture.getInternalTexture());
    const views = [];
    for (let level = 0; level < gpuTexture.mipLevelCount; level++) {
        views.push(gpuTexture.createView({ dimension, baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: layerCount }));
    }
    return views;
}

export function storageTextureForView(name, view) {
    return {
        name,
        uniqueId: -1,
        isReady: () => true,
        _texture: { _hardwareTexture: { viewForWriting: view, textureAdditionalUsages: 8 } },
    };
}

export function sampledInternalTextureForView(view) {
    return { _hardwareTexture: { view } };
}

export function copyWholeTexture(engine, sourceTexture, destinationTexture, width, height) {
    const encoder = engine._renderEncoder;
    encoder.copyTextureToTexture(
        { texture: getGpuTextureOfInternalTexture(sourceTexture.getInternalTexture()) },
        { texture: getGpuTextureOfInternalTexture(destinationTexture.getInternalTexture()) },
        { width, height, depthOrArrayLayers: 1 },
    );
}
