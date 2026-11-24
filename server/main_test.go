package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEmbeddedPage(t *testing.T) {
	for _, path := range []string{"/", "/index.html"} {
		recorder := httptest.NewRecorder()
		handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "<html") {
			t.Errorf("GET %s: status %d, expected embedded HTML", path, recorder.Code)
		}
		if got := recorder.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
			t.Errorf("GET %s: content type %q", path, got)
		}
	}
}

func TestUnknownPath(t *testing.T) {
	recorder := httptest.NewRecorder()
	handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/missing", nil))
	if recorder.Code != http.StatusNotFound {
		t.Errorf("GET /missing: status %d", recorder.Code)
	}
}
