import { mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { extname } from "path";

import { rollup } from "rollup";
import esbuild from "rollup-plugin-esbuild";
import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import swc from "@swc/core";

const extensions = [".js", ".jsx", ".mjs", ".ts", ".tsx", ".cts", ".mts"];

const plugins = [
    nodeResolve(),
    commonjs(),
    {
        name: "swc",
        async transform(code, id) {
            const ext = extname(id);
            if (!extensions.includes(ext)) return null;

            const ts = ext.includes("ts");
            const tsx = ts ? ext.endsWith("x") : undefined;
            const jsx = !ts ? ext.endsWith("x") : undefined;

            const result = await swc.transform(code, {
                filename: id,
                jsc: {
                    externalHelpers: true,
                    parser: {
                        syntax: ts ? "typescript" : "ecmascript",
                        tsx,
                        jsx
                    }
                },
                env: {
                    targets: "defaults",
                    include: [
                        "transform-classes",
                        "transform-arrow-functions"
                    ]
                }
            });

            return result.code;
        }
    },
    esbuild({ minify: true })
];

for (const plug of await readdir("./plugins")) {
    const manifest = JSON.parse(await readFile(`./plugins/${plug}/manifest.json`, "utf8"));
    const outDir = `./${plug}`;
    const outPath = `${outDir}/index.js`;

    try {
        await rm(outDir, { recursive: true, force: true });
        await mkdir(outDir, { recursive: true });

        const bundle = await rollup({
            input: `./plugins/${plug}/${manifest.main}`,
            onwarn: () => {},
            plugins
        });

        await bundle.write({
            file: outPath,
            globals(id) {
                if (id.startsWith("@vendetta")) return id.substring(1).replace(/\//g, ".");
                if (id === "react") return "window.React";
                return null;
            },
            format: "iife",
            compact: true,
            exports: "named"
        });

        await bundle.close();

        const built = await readFile(outPath);
        manifest.hash = createHash("sha256").update(built).digest("hex");
        manifest.main = "index.js";

        await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest));
        console.log(`Successfully built ${manifest.name}!`);
    } catch (error) {
        console.error(`Failed to build ${plug}`, error);
        process.exit(1);
    }
}
