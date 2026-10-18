import { MultiRenderTarget } from "@babylonjs/core/Materials/Textures/multiRenderTarget";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { Color4 } from "@babylonjs/core/Maths/math.color";

const allocationStepFraction = 0.1;
const shrinkHysteresisMilliseconds = 2000;

export function createColourTarget(scene, name, width, height, { samplingMode = Constants.TEXTURE_BILINEAR_SAMPLINGMODE, type = Constants.TEXTURETYPE_HALF_FLOAT } = {}) {
    const target = new RenderTargetTexture(name, { width, height }, scene, {
        generateMipMaps: false,
        doNotChangeAspectRatio: true,
        type,
        samplingMode,
        generateDepthBuffer: false,
        generateStencilBuffer: false,
        format: Constants.TEXTUREFORMAT_RGBA,
    });
    target.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    target.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    target.ignoreCameraViewport = true;
    target.clearColor = new Color4(0, 0, 0, 0);
    return target;
}

export class BeautyTargets {
    constructor(scene, allocationPolicy = "max") {
        this.scene = scene;
        this.allocationPolicy = allocationPolicy;
        this.multiRenderTarget = null;
        this.allocatedWidth = 0;
        this.allocatedHeight = 0;
        this.internalWidth = 0;
        this.internalHeight = 0;
        this.generation = 0;
        this.reallocationCount = 0;
        this.viewport = new Viewport(0, 0, 1, 1);
        this.belowCurrentStepSinceMilliseconds = -1;
        this.subRectangleUvScale = new Float32Array(2);
        this.onReallocatedListeners = [];
    }

    setAllocationPolicy(policy) {
        this.allocationPolicy = policy;
        this.allocatedWidth = 0;
        this.allocatedHeight = 0;
    }

    allocate(width, height) {
        if (this.multiRenderTarget) {
            this.multiRenderTarget.dispose();
        }
        this.multiRenderTarget = new MultiRenderTarget(
            "beauty",
            { width, height },
            2,
            this.scene,
            {
                types: [Constants.TEXTURETYPE_HALF_FLOAT, Constants.TEXTURETYPE_HALF_FLOAT],
                samplingModes: [Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURE_NEAREST_SAMPLINGMODE],
                generateMipMaps: false,
                generateDepthBuffer: true,
                generateStencilBuffer: false,
                doNotChangeAspectRatio: true,
            },
            ["beautyColour", "beautyMotion"],
        );
        this.multiRenderTarget.clearColor = new Color4(0, 0, 0, 0);
        for (const texture of this.multiRenderTarget.textures) {
            texture.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
            texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        }
        this.allocatedWidth = width;
        this.allocatedHeight = height;
        this.generation++;
        this.reallocationCount++;
        for (const listener of this.onReallocatedListeners) {
            listener(this);
        }
    }

    ensure(outputWidth, outputHeight, internalWidth, internalHeight, nowMilliseconds) {
        let wantedWidth = outputWidth;
        let wantedHeight = outputHeight;
        if (this.allocationPolicy === "steps") {
            const scale = Math.max(internalWidth / outputWidth, internalHeight / outputHeight);
            const steppedScale = Math.min(1, Math.ceil(scale / allocationStepFraction - 1e-6) * allocationStepFraction);
            wantedWidth = Math.ceil(outputWidth * steppedScale);
            wantedHeight = Math.ceil(outputHeight * steppedScale);
            const fitsCurrent = this.allocatedWidth >= internalWidth && this.allocatedHeight >= internalHeight;
            const muchLarger = this.allocatedWidth > wantedWidth + 1 || this.allocatedHeight > wantedHeight + 1;
            if (fitsCurrent && muchLarger) {
                if (this.belowCurrentStepSinceMilliseconds < 0) {
                    this.belowCurrentStepSinceMilliseconds = nowMilliseconds;
                }
                if (nowMilliseconds - this.belowCurrentStepSinceMilliseconds < shrinkHysteresisMilliseconds) {
                    wantedWidth = this.allocatedWidth;
                    wantedHeight = this.allocatedHeight;
                }
            } else {
                this.belowCurrentStepSinceMilliseconds = -1;
            }
            if (fitsCurrent && !muchLarger) {
                wantedWidth = this.allocatedWidth;
                wantedHeight = this.allocatedHeight;
            }
        }
        if (wantedWidth !== this.allocatedWidth || wantedHeight !== this.allocatedHeight) {
            this.allocate(wantedWidth, wantedHeight);
        }
        this.internalWidth = Math.min(internalWidth, this.allocatedWidth);
        this.internalHeight = Math.min(internalHeight, this.allocatedHeight);
        this.viewport.x = 0;
        this.viewport.y = 0;
        this.viewport.width = this.internalWidth / this.allocatedWidth;
        this.viewport.height = this.internalHeight / this.allocatedHeight;
        this.subRectangleUvScale[0] = this.viewport.width;
        this.subRectangleUvScale[1] = this.viewport.height;
    }

    get colourTexture() {
        return this.multiRenderTarget.textures[0];
    }

    get motionTexture() {
        return this.multiRenderTarget.textures[1];
    }
}
