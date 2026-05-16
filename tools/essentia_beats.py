#!/usr/bin/env python3
"""Build-time source for Beat Detect's optional Essentia runner.

This file is not required on editor machines. Build it into bin/essentia_beats.exe
with scripts/build-essentia-runner.ps1, then build BeatDetectSetup.exe.
"""

import argparse
import json
import sys


def clamp(value, low, high):
    return max(low, min(high, value))


def score_for_mode(confidence, mode):
    confidence = clamp(float(confidence or 0.0), 0.0, 1.0)
    if mode == "vocal":
        return 0.34 + confidence * 0.22
    if mode == "music":
        return 0.52 + confidence * 0.26
    return 0.48 + confidence * 0.24


def main():
    parser = argparse.ArgumentParser(description="Beat Detect Essentia beat-grid runner.")
    parser.add_argument("--mode", choices=["spikes", "music", "vocal"], default="music")
    parser.add_argument("media_path")
    args = parser.parse_args()

    try:
        import essentia.standard as es
    except Exception as error:
        print(f"Could not import essentia.standard: {error}", file=sys.stderr)
        return 2

    try:
        audio = es.MonoLoader(filename=args.media_path)()
        rhythm = es.RhythmExtractor2013(method="multifeature")
        bpm, beats, confidence, estimates, intervals = rhythm(audio)
        score = score_for_mode(confidence, args.mode)
        events = [
            {"time": round(float(beat), 3), "score": round(score, 3)}
            for beat in beats
            if float(beat) >= 0.0
        ]
        payload = {
            "engine": "essentia",
            "algorithm": "RhythmExtractor2013(multifeature)",
            "bpm": round(float(bpm), 3),
            "confidence": round(float(confidence), 3),
            "events": events,
            "estimate_count": len(estimates),
            "interval_count": len(intervals),
        }
        print(json.dumps(payload, separators=(",", ":")))
        return 0
    except Exception as error:
        print(f"Essentia analysis failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
