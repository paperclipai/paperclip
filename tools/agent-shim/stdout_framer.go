package main

import (
	"bufio"
	"io"
	"os"
)

// streamWithFraming copies src to dst, optionally injecting framing prefixes.
// V1: pass-through. Adapter CLIs already emit JSON-line events.
func streamWithFraming(src io.Reader, dst io.Writer) error {
	scanner := bufio.NewScanner(src)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // accept up to 4MB lines
	for scanner.Scan() {
		line := scanner.Bytes()
		if _, err := dst.Write(line); err != nil {
			return err
		}
		if _, err := dst.Write([]byte{'\n'}); err != nil {
			return err
		}
		if f, ok := dst.(*os.File); ok {
			_ = f.Sync()
		}
	}
	return scanner.Err()
}
