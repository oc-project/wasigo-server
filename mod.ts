export function DenoHandler(
  memory: WebAssembly.Memory,
  alloc: (len: number) => number,
  free: (ptr: number, len: number) => void,
  handle: (ptr: number, len: number) => bigint, // i64 返回 BigInt
): Deno.ServeHandler<Deno.NetAddr> {
  return async (req) => {
    const payload = await encodeRequest(req);
    // 拷贝到 WASM 内存
    const reqPtr = alloc(payload.length);
    new Uint8Array(memory.buffer, reqPtr, payload.length).set(payload);

    // 调用 Go -> 获得 (len<<32 | ptr)
    const packed = handle(reqPtr, payload.length);
    const respPtr = Number(packed & 0xffffffffn);
    const respLen = Number(packed >> 32n);

    const respBytes = new Uint8Array(memory.buffer, respPtr, respLen);
    // Copy out before Free，避免后续 GC
    const respCopy = new Uint8Array(respBytes);

    // 释放内存
    free(reqPtr, payload.length);
    free(respPtr, respLen);

    return decodeResponse(respCopy);
  };
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
