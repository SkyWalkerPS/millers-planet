import { installPageApi } from "./core/api.js";
import { readUrlParameters } from "./core/params.js";
import { MillersPlanetApp } from "./core/app.js";
import { WebGpuUnavailableError, showWebGpuMissingLine } from "./core/engine.js";

const pageApi = installPageApi();
const canvas = document.getElementById("scene");

MillersPlanetApp.boot(canvas, readUrlParameters())
    .then((application) => pageApi.attach(application))
    .catch((error) => {
        if (error instanceof WebGpuUnavailableError) {
            showWebGpuMissingLine();
        }
        console.error(error);
        pageApi.fail(error);
    });
