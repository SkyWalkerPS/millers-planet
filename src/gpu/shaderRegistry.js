import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import "@babylonjs/core/ShadersWGSL/postprocess.vertex";

const wgslSourcesByPath = import.meta.glob("../**/*.wgsl", { query: "?raw", import: "default", eager: true });

const shaderKindSuffixes = [
    [".vertex.wgsl", "VertexShader", "ShadersStoreWGSL"],
    [".fragment.wgsl", "FragmentShader", "ShadersStoreWGSL"],
    [".compute.wgsl", "ComputeShader", "ShadersStoreWGSL"],
    [".include.wgsl", "", "IncludesShadersStoreWGSL"],
];

const sourcesByShaderName = new Map();
let registrationDone = false;

export function registerAllShaders() {
    if (registrationDone) {
        return;
    }
    for (const [path, source] of Object.entries(wgslSourcesByPath)) {
        const fileName = path.slice(path.lastIndexOf("/") + 1);
        const kind = shaderKindSuffixes.find(([suffix]) => fileName.endsWith(suffix));
        if (!kind) {
            throw new Error(`WGSL file ${path} does not end in .vertex/.fragment/.compute/.include.wgsl`);
        }
        const [suffix, storeSuffix, storeName] = kind;
        const baseName = fileName.slice(0, -suffix.length);
        const storeKey = `${baseName}${storeSuffix}`;
        if (sourcesByShaderName.has(storeKey)) {
            throw new Error(`Two WGSL files register ${storeKey}`);
        }
        ShaderStore[storeName][storeKey] = source;
        sourcesByShaderName.set(storeKey, source);
    }
    registrationDone = true;
}

export function getFragmentSource(baseName) {
    const source = sourcesByShaderName.get(`${baseName}FragmentShader`);
    if (source === undefined) {
        throw new Error(`No fragment shader named ${baseName}`);
    }
    return source;
}

export function getComputeSource(baseName) {
    const source = sourcesByShaderName.get(`${baseName}ComputeShader`);
    if (source === undefined) {
        throw new Error(`No compute shader named ${baseName}`);
    }
    return source;
}
