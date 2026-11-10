import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { RtspPlayerCore } from './core';
import type { PlayerOptions, PlayerStatus } from './core';

export { RtspPlayerCore, buildSocketUrl, isPlayerSupported } from './core';
export type { PlayerOptions, PlayerStatus } from './core';

/**
 * Connects an existing `<video>` element to a camera.
 * Reconnects whenever `url`, `stream`, `server`, `transcode` or `audio` change.
 */
export function useRtspPlayer(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  options: PlayerOptions,
): { status: PlayerStatus; error: string | null } {
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const callbacks = useRef(options);
  callbacks.current = options;

  const { url, stream, server, transcode, audio, maxLatency, reconnect } = options;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    setError(null);
    const player = new RtspPlayerCore(video, {
      url,
      stream,
      server,
      transcode,
      audio,
      maxLatency,
      reconnect,
      onStatusChange: (s) => {
        setStatus(s);
        if (s === 'playing') setError(null);
        callbacks.current.onStatusChange?.(s);
      },
      onError: (message) => {
        setError(message);
        callbacks.current.onError?.(message);
      },
    });
    player.start();
    return () => player.destroy();
  }, [videoRef, url, stream, server, transcode, audio, maxLatency, reconnect]);

  return { status, error };
}

export interface RtspPlayerLabels {
  connecting?: React.ReactNode;
  reconnecting?: React.ReactNode;
  error?: React.ReactNode;
}

export interface RtspPlayerProps
  extends PlayerOptions,
    Omit<React.VideoHTMLAttributes<HTMLVideoElement>, 'src' | 'onError'> {
  /** Show a status overlay (connecting / reconnecting / error). @default true */
  showStatus?: boolean;
  /** Texts of the status overlay. */
  labels?: RtspPlayerLabels;
  /** Class name of the wrapper `<div>`. */
  wrapperClassName?: string;
  /** Style of the wrapper `<div>`. */
  wrapperStyle?: React.CSSProperties;
}

const defaultLabels: Required<RtspPlayerLabels> = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  error: 'Stream unavailable',
};

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: 12,
  textAlign: 'center',
  color: '#fff',
  font: '500 14px/1.4 system-ui, sans-serif',
  background: 'rgba(0, 0, 0, 0.55)',
  pointerEvents: 'none',
};

/**
 * Plays an RTSP camera in the browser through rtsp-player-server.
 *
 * ```tsx
 * <RtspPlayer url="rtsp://admin:pass@192.168.1.10:554/stream1" />
 * ```
 */
export const RtspPlayer = forwardRef<HTMLVideoElement, RtspPlayerProps>(function RtspPlayer(props, ref) {
  const {
    url,
    stream,
    server,
    transcode,
    audio,
    maxLatency,
    reconnect,
    onStatusChange,
    onError,
    showStatus = true,
    labels,
    wrapperClassName,
    wrapperStyle,
    style,
    autoPlay = true,
    muted = true,
    playsInline = true,
    ...videoProps
  } = props;

  const videoRef = useRef<HTMLVideoElement>(null);
  useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

  const { status, error } = useRtspPlayer(videoRef, {
    url,
    stream,
    server,
    transcode,
    audio,
    maxLatency,
    reconnect,
    onStatusChange,
    onError,
  });

  const text = { ...defaultLabels, ...labels };
  const overlay =
    status === 'connecting' || status === 'idle'
      ? text.connecting
      : status === 'reconnecting'
        ? text.reconnecting
        : status === 'error'
          ? text.error
          : null;

  return (
    <div
      className={wrapperClassName}
      style={{ position: 'relative', background: '#000', overflow: 'hidden', ...wrapperStyle }}
      data-status={status}
    >
      <video
        ref={videoRef}
        autoPlay={autoPlay}
        muted={muted}
        playsInline={playsInline}
        style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain', ...style }}
        {...videoProps}
      />
      {showStatus && overlay !== null && (
        <div style={overlayStyle} role="status" aria-live="polite">
          <span>{overlay}</span>
          {(status === 'error' || status === 'reconnecting') && error && <small style={{ opacity: 0.75, fontWeight: 400 }}>{error}</small>}
        </div>
      )}
    </div>
  );
});
