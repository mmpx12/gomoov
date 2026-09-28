//go:build windows

package main

import (
	"os/exec"
	"time"
)

func setProcGroup(cmd *exec.Cmd) {
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return cmd.Process.Kill()
	}
	cmd.WaitDelay = 2 * time.Second
}
