/**
 * CameraView — live LCD camera feed.
 *
 * Shows the cropped webcam view of the device LCD at the top of the
 * UI. Auto-refreshes every second (matching server-side 1 fps capture).
 * Hides itself if no camera is configured or the server reports the
 * camera is unavailable.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const REFRESH_INTERVAL_MS = 1000;

interface CameraViewProps {
  onVisibilityChange?: (visible: boolean) => void;
}

export function CameraView({ onVisibilityChange }: CameraViewProps) {
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check if camera is available on mount
  useEffect(() => {
    fetch('/api/camera/status')
      .then(r => r.json())
      .then((status: { configured: boolean; running: boolean }) => {
        setVisible(status.configured && status.running);
      })
      .catch(() => setVisible(false));
  }, []);

  // Notify parent of visibility changes
  useEffect(() => {
    onVisibilityChange?.(visible);
  }, [visible, onVisibilityChange]);

  // Refresh the image periodically
  const refresh = useCallback(() => {
    if (!imgRef.current) return;
    imgRef.current.src = `/api/camera/frame?t=${Date.now()}`;
  }, []);

  useEffect(() => {
    if (!visible) return;
    refresh();
    timerRef.current = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [visible, refresh]);

  if (!visible) return null;

  return (
    <div className="camera-view">
      <img
        ref={imgRef}
        className={`camera-img${error ? ' camera-error' : ''}`}
        alt="LCD display"
        onError={() => setError(true)}
        onLoad={() => setError(false)}
      />
      {error && <span className="camera-offline">Camera offline</span>}
    </div>
  );
}
