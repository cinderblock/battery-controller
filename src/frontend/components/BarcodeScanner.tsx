/**
 * BarcodeScanner — live camera barcode scanner.
 *
 * Uses native BarcodeDetector (Chrome Android) or zbar.wasm (loaded
 * from CDN at runtime, for iOS Safari with HTTPS). Falls back to
 * showing an explanation when camera access is unavailable (iOS over
 * plain HTTP).
 *
 * Streams the rear camera feed into a <video>, samples frames onto
 * an offscreen canvas, and decodes barcodes. On successful decode,
 * calls onScan with the barcode text and stops scanning.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { hasCameraAccess, scanImageData } from '../lib/barcode-scanner.ts';

// ── Types ──────────────────────────────────────────────────────────

interface BarcodeScannerProps {
  onScan: (barcode: string) => void;
  onClose: () => void;
}

type ScanState =
  | { status: 'initializing' }
  | { status: 'scanning' }
  | { status: 'found'; barcode: string }
  | { status: 'error'; message: string };

// ── Component ──────────────────────────────────────────────────────

export function BarcodeScanner({ onScan, onClose }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);
  const [scanState, setScanState] = useState<ScanState>({ status: 'initializing' });

  const cleanup = useCallback(() => {
    if (scanTimerRef.current !== null) {
      cancelAnimationFrame(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!hasCameraAccess()) {
        setScanState({
          status: 'error',
          message: 'Camera not available. On iOS, camera requires HTTPS. Type the barcode manually.',
        });
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }

        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;

        video.srcObject = stream;
        await video.play();
        setScanState({ status: 'scanning' });

        if (cancelled) {
          cleanup();
          return;
        }

        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        let lastScanTime = 0;
        const SCAN_INTERVAL_MS = 200;

        function scanFrame(timestamp: number) {
          if (cancelled) return;

          if (timestamp - lastScanTime >= SCAN_INTERVAL_MS) {
            lastScanTime = timestamp;

            const v = videoRef.current;
            if (v && v.readyState >= v.HAVE_CURRENT_DATA) {
              canvas!.width = v.videoWidth;
              canvas!.height = v.videoHeight;
              ctx!.drawImage(v, 0, 0);
              const imageData = ctx!.getImageData(0, 0, canvas!.width, canvas!.height);

              scanImageData(imageData)
                .then(barcode => {
                  if (cancelled || !barcode) return;
                  setScanState({ status: 'found', barcode });
                  cleanup();
                  setTimeout(() => {
                    if (!cancelled) onScan(barcode);
                  }, 400);
                })
                .catch(() => {
                  // Scan errors are non-fatal — just skip this frame
                });
            }
          }

          scanTimerRef.current = requestAnimationFrame(scanFrame);
        }

        scanTimerRef.current = requestAnimationFrame(scanFrame);
      } catch (err) {
        if (cancelled) return;

        let message = 'Camera access denied.';
        if (err instanceof DOMException) {
          if (err.name === 'NotAllowedError') {
            message = 'Camera permission denied. Allow camera access in browser settings, then try again.';
          } else if (err.name === 'NotFoundError') {
            message = 'No camera found on this device.';
          } else if (err.name === 'NotReadableError') {
            message = 'Camera is in use by another app.';
          } else if (err.name === 'SecurityError') {
            message = 'Camera requires HTTPS. Type the barcode manually.';
          }
        }
        setScanState({ status: 'error', message });
      }
    }

    start();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [cleanup, onScan]);

  return (
    <div className="scanner-container">
      <div className="scanner-header">
        <span>Scan Barcode</span>
        <button
          className="scanner-close"
          onClick={() => {
            cleanup();
            onClose();
          }}
        >
          &times;
        </button>
      </div>

      <div className="scanner-viewport">
        <video ref={videoRef} className="scanner-video" playsInline muted />
        <canvas ref={canvasRef} className="scanner-canvas" />

        {scanState.status === 'scanning' && (
          <div className="scanner-overlay">
            <div className="scanner-guide" />
            <span className="scanner-hint">Point at barcode</span>
          </div>
        )}

        {scanState.status === 'found' && (
          <div className="scanner-overlay scanner-found">
            <span className="scanner-found-text">{scanState.barcode}</span>
          </div>
        )}

        {scanState.status === 'initializing' && (
          <div className="scanner-overlay">
            <span className="scanner-hint">Starting camera...</span>
          </div>
        )}

        {scanState.status === 'error' && (
          <div className="scanner-error">
            <p>{scanState.message}</p>
          </div>
        )}
      </div>
    </div>
  );
}
