package wasigo_server

import (
	"bufio"
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"sync"
	"unsafe"
)

// userHandler 由外部代码通过 SetHandler 注入；若未设置，返回 500。
var userHandler http.Handler

// SetHandler 允许用户在 init() 或 main() 中注册自定义 http.Handler。
// 在编译为 WASM 时，用户需要确保调用此函数一次。
func SetHandler(h http.Handler) {
	userHandler = h
}

var (
	heapMu sync.Mutex
	blobs  = make(map[uint32][]byte) // ptr -> slice，保证 GC 不回收
)

//go:wasmexport Alloc
func Alloc(size uint32) uint32 {
	heapMu.Lock()
	defer heapMu.Unlock()
	b := make([]byte, size)
	ptr := uint32(uintptr(unsafe.Pointer(&b[0])))
	blobs[ptr] = b
	return ptr
}

//go:wasmexport Free
func Free(ptr uint32, size uint32) {
	heapMu.Lock()
	defer heapMu.Unlock()
	delete(blobs, ptr)
}

// ---- 辅助：把 (ptr,len) 转为 []byte ----
func sliceFrom(ptr, length uint32) []byte {
	//nolint:staticcheck // 使用 unsafe.Slice 将线性内存映射为 Go slice
	return unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), int(length))
}

const workerNum = 16

type task struct {
	reqBytes []byte
	respCh   chan []byte
}

var (
	once      sync.Once
	taskQueue chan task
)

func initWorkerPool() {
	taskQueue = make(chan task, 128)
	for i := 0; i < workerNum; i++ {
		go func() {
			for t := range taskQueue {
				t.respCh <- processRequest(t.reqBytes)
			}
		}()
	}
}

func processRequest(reqBytes []byte) []byte {
	// 1. 反序列化 HTTP 请求
	req, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(reqBytes)))
	if err != nil {
		return []byte("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
	}

	if userHandler == nil {
		return []byte("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n")
	}

	// 2. 调用业务 Handler
	rec := httptest.NewRecorder()
	userHandler.ServeHTTP(rec, req)

	// 3. 序列化 Response
	raw, _ := httputil.DumpResponse(rec.Result(), true)
	return raw
}

// ---------------- 业务入口 ----------------

//go:wasmexport Handle
func Handle(reqPtr, reqLen uint32) uint64 {
	once.Do(initWorkerPool)

	// 拷贝请求数据，避免后续 Free 造成悬空引用
	src := sliceFrom(reqPtr, reqLen)
	reqCopy := make([]byte, reqLen)
	copy(reqCopy, src)

	respCh := make(chan []byte, 1)
	taskQueue <- task{reqBytes: reqCopy, respCh: respCh}
	raw := <-respCh
	return packResp(raw)
}

func packResp(b []byte) uint64 {
	ptr := Alloc(uint32(len(b)))
	copy(sliceFrom(ptr, uint32(len(b))), b)
	length := uint32(len(b))
	return uint64(length)<<32 | uint64(ptr)
}
