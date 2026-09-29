package main

import (
	"bytes"
	"image"
	"image/jpeg"
	"testing"
)

func encodeStill(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestStillUsableSkipsSolidFrames(t *testing.T) {
	flat := image.NewYCbCr(image.Rect(0, 0, 320, 180), image.YCbCrSubsampleRatio420)
	for i := range flat.Y {
		flat.Y[i] = 16
	}
	for i := range flat.Cb {
		flat.Cb[i] = 128
		flat.Cr[i] = 128
	}
	solid := encodeStill(t, flat)
	for len(solid) < 800 {
		solid = append(solid, 0)
	}
	if stillScore(solid) != 0 && stillUsable(solid) {
		t.Fatalf("solid frame looked usable, score %.2f", stillScore(solid))
	}
	if stillUsable(solid) {
		t.Fatal("solid frame was usable")
	}

	contrast := image.NewYCbCr(image.Rect(0, 0, 320, 180), image.YCbCrSubsampleRatio420)
	for y := 0; y < 180; y++ {
		for x := 0; x < 320; x++ {
			v := byte(16)
			if (x/20+y/20)%2 == 0 {
				v = 220
			}
			contrast.Y[contrast.YOffset(x, y)] = v
		}
	}
	for i := range contrast.Cb {
		contrast.Cb[i] = 128
		contrast.Cr[i] = 128
	}
	picture := encodeStill(t, contrast)
	if !stillUsable(picture) {
		t.Fatalf("contrasting frame was rejected, score %.2f bytes %d", stillScore(picture), len(picture))
	}
	if stillScore(nil) != 0 || stillUsable([]byte("nope")) {
		t.Fatal("short input should score as blank")
	}
}
