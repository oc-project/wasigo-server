// 示例：启动 Go WASI HTTP 服务器

import { DenoHandler } from "../mod.ts";
import Context from "https://deno.land/std@0.204.0/wasi/snapshot_preview1.ts";

// 1. 初始化 WASI + 加载 WASM
const wasi = new Context();
const module_ = await WebAssembly.compile(await Deno.readFile(new URL("./h.wasm", import.meta.url)));
const instance = await WebAssembly.instantiate(module_, {
    wasi_snapshot_preview1: wasi.exports,
});
wasi.initialize(instance);

const { memory, Alloc, Free, Handle } = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    Alloc: (len: number) => number;
    Free: (ptr: number, len: number) => void;
    Handle: (ptr: number, len: number) => bigint; // i64 返回 BigInt
};

Deno.serve(DenoHandler(memory, Alloc, Free, Handle))
