package main

import (
	"net/http"

	wasigo_server "github.com/oc-project/wasigo-server"
)

type myHandler struct{}

func (h myHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("hello from user code"))
}

func init() {
	wasigo_server.SetHandler(myHandler{})
}

func main() {}
