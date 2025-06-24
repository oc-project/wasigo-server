import Context from "https://deno.land/std@0.204.0/wasi/snapshot_preview1.ts";

export interface WasigoOptions {
  /** HTTP 监听端口，默认 8000 */
  port?: number;
  /** 控制 wasi Context 的 exitOnReturn，默认 false 以避免提前退出 */
  exitOnReturn?: boolean;
}

export async function start(
  wasmPath: string | URL,
  opts: WasigoOptions = {},
): Promise<void> {
  const { port = 8000, exitOnReturn = false } = opts;

  // 1. 初始化 WASI + 加载 WASM
  const wasi = new Context({ exitOnReturn });
  const wasmBin = wasmPath instanceof URL
    ? await Deno.readFile(wasmPath)
    : await Deno.readFile(String(wasmPath));
  const module_ = await WebAssembly.compile(wasmBin);
  const instance = await WebAssembly.instantiate(module_, {
    wasi_snapshot_preview1: wasi.exports,
  });

  // 调用 _initialize 以运行 Go 侧的初始化逻辑
  wasi.initialize(instance);

  // 取出导出符号
  const { memory, Alloc, Free, Handle } = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    Alloc: (len: number) => number;
    Free: (ptr: number, len: number) => void;
    Handle: (ptr: number, len: number) => bigint; // i64 返回 BigInt
  };

  // 2. 启动 HTTP 服务器
  await Deno.serve({ port }, async (req) => {
    const payload = await encodeRequest(req);

    // 拷贝到 WASM 内存
    const reqPtr = Alloc(payload.length);
    new Uint8Array(memory.buffer, reqPtr, payload.length).set(payload);

    // 调用 Go -> 获得 (len<<32 | ptr)
    const packed = Handle(reqPtr, payload.length);
    const respPtr = Number(packed & 0xffffffffn);
    const respLen = Number(packed >> 32n);

    const respBytes = new Uint8Array(memory.buffer, respPtr, respLen);
    // Copy out before Free，避免后续 GC
    const respCopy = new Uint8Array(respBytes);

    // 释放内存
    Free(reqPtr, payload.length);
    Free(respPtr, respLen);

    return decodeResponse(respCopy);
  });
}

// ---------------- 编码/解码 HTTP ----------------

async function encodeRequest(req: Request): Promise<Uint8Array> {
  const url = new URL(req.url);
  const head = `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n` +
    [...req.headers].map(([k, v]) => `${k}: ${v}`).join("\r\n") +
    "\r\n\r\n";
  const headBuf = new TextEncoder().encode(head);
  const bodyBuf = new Uint8Array(await req.arrayBuffer());
  const payload = new Uint8Array(headBuf.length + bodyBuf.length);
  payload.set(headBuf);
  payload.set(bodyBuf, headBuf.length);
  return payload;
}

function decodeResponse(raw: Uint8Array): Response {
  // 找到头部结束位置 (\r\n\r\n)
  let headerEnd = 0;
  for (let i = 0; i < raw.length - 3; i++) {
    if (
      raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 &&
      raw[i + 3] === 10
    ) {
      headerEnd = i + 4;
      break;
    }
  }

  // 若未找到头部，直接返回 502
  if (headerEnd === 0) {
    return new Response(raw, { status: 502, statusText: "Bad Gateway" });
  }

  const headText = new TextDecoder().decode(raw.slice(0, headerEnd - 4));
  const body = raw.slice(headerEnd);

  const [statusLine, ...headerLines] = headText.split("\r\n");
  const match = statusLine.match(/^HTTP\/\d\.\d (\d{3}) (.*)$/);
  if (!match) {
    return new Response(raw, { status: 502, statusText: "Bad Gateway" });
  }
  const [, statusCodeStr, statusText] = match;
  const headers = new Headers();
  for (const line of headerLines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1).trimStart();
    headers.append(key, value);
  }

  return new Response(body, {
    status: Number(statusCodeStr),
    statusText,
    headers,
  });
}
