#!/usr/bin/env python3
"""Monitor SSE readings and log the capacity field7 transition.

Polls the coulomb SSE stream every ~5s, prints compact readings,
and captures detailed data around the transition when field7 goes non-zero.
"""

import json
import sys
import time
import urllib.request

URL = "http://coulomb.tomsawyerlabs.com/api/events"
OUTPUT = "scripts/transition-capture.jsonl"

def get_reading():
    """Grab a single reading from the SSE stream."""
    req = urllib.request.Request(URL)
    with urllib.request.urlopen(req, timeout=10) as resp:
        buf = b""
        for _ in range(200):  # read up to 200 lines to find a reading
            line = resp.readline().decode()
            if line.startswith("data:"):
                d = json.loads(line[5:])
                if "voltage" in d and "current" in d and "mode" in d:
                    return d
    return None


def main():
    print("Monitoring for field7 transition...")
    print(f"Logging to {OUTPUT}")
    prev_field7 = 0
    transition_detected = False
    readings_after_transition = 0

    with open(OUTPUT, "a") as f:
        while True:
            try:
                r = get_reading()
                if r is None:
                    print("  (no reading)")
                    time.sleep(5)
                    continue

                cap = r["capacityMah"]
                f7 = r["rawField7"]
                mode = r["mode"]
                v = r["voltage"]
                i = r["current"]
                elapsed = r.get("elapsedS", 0)

                # Always log to file
                f.write(json.dumps({
                    "t": time.time(),
                    "elapsed": elapsed,
                    "cap": cap,
                    "field7": f7,
                    "v": v,
                    "i": i,
                    "mode": mode,
                }) + "\n")
                f.flush()

                # Detect transition
                if f7 != 0 and prev_field7 == 0:
                    transition_detected = True
                    print(f"\n*** TRANSITION DETECTED ***")
                    print(f"  field7 went from 0 to {f7}")
                    print(f"  capacity={cap} voltage={v} current={i}")
                    print(f"  elapsed={elapsed:.0f}s")
                    print()

                if transition_detected:
                    readings_after_transition += 1

                # Compact display
                marker = " <<<" if transition_detected and readings_after_transition <= 30 else ""
                print(f"  elapsed={elapsed:>7.0f}s  cap={cap:>8.0f}  field7={f7:>6}  V={v:>6.3f}  I={i:>5.1f}  {mode}{marker}")

                prev_field7 = f7

                # After 60 readings post-transition, we have enough data
                if readings_after_transition > 60:
                    print("\nGot enough post-transition data. Done.")
                    break

                # If test ended, stop
                if mode == "idle" and elapsed == 0:
                    print("\nTest ended (device idle). Stopping.")
                    break

            except Exception as e:
                print(f"  Error: {e}")

            time.sleep(5)

    print(f"\nCapture saved to {OUTPUT}")


if __name__ == "__main__":
    main()
