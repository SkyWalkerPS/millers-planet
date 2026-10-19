import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const licenceFilesShippedWithTheSite = [
    ["LICENSE", "LICENSE.txt"],
    ["THIRD-PARTY-NOTICES.md", "THIRD-PARTY-NOTICES.txt"],
];

function shipLicenceFiles() {
    return {
        name: "ship-licence-files",
        generateBundle() {
            for (const [sourceFileName, publishedFileName] of licenceFilesShippedWithTheSite) {
                this.emitFile({ type: "asset", fileName: publishedFileName, source: readFileSync(new URL(sourceFileName, import.meta.url), "utf8") });
            }
        },
    };
}

export default defineConfig({
    plugins: [shipLicenceFiles()],
    server: {
        port: 5173,
        strictPort: false,
    },
    build: {
        target: "esnext",
        sourcemap: false,
    },
    optimizeDeps: {
        exclude: ["@babylonjs/core"],
    },
});
