// 示例：启动 Go WASI HTTP 服务器
// deno run -A examples/basic_server.ts
import { start } from "../mod.ts";

await start(new URL("./h.wasm", import.meta.url), { port: 8000 });
