import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { acceptsAnalysis, acceptsResult } from './evaluation.ts';
import type { Analysis, PositionRequest } from './types.ts';

type Connection = 'connecting' | 'connected' | 'disconnected' | 'busy';
type EngineInfo = { engine: string | null; threads: number; hash_mb: number };

export function useAnalysis(position: PositionRequest, enabled: boolean, suspended = false) {
  const desired = useRef(position);
  const socket = useRef<WebSocket | null>(null);
  const activeId = useRef<string | null>(null);
  const sequence = useRef(0);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [result, setResult] = useState<(Analysis & { key: string }) | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [reconnect, setReconnect] = useState(0);
  const paused = useRef(false);
  const enabledRef = useRef(enabled);
  const suspendedRef = useRef(suspended);
  const searchRunning = useRef(false);
  const resumeAfterEdit = useRef(false);

  const markRunning = useCallback((value: boolean) => {
    searchRunning.current = value;
    setRunning(value);
  }, []);

  const launch = useCallback(() => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || paused.current || suspendedRef.current || !enabledRef.current) return;
    const requestId = `${Date.now()}-${++sequence.current}`;
    activeId.current = requestId;
    setResult(null); setError(''); markRunning(true);
    const { root_fen, moves, mode, multipv } = desired.current;
    ws.send(JSON.stringify({type: 'analyze', request_id: requestId, root_fen, moves, mode, multipv}));
  }, [markRunning]);

  const halt = useCallback(() => {
    activeId.current = null; // Synchronous, before React commits the new position.
    markRunning(false);
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify({type: 'stop'}));
  }, [markRunning]);

  const invalidate = useCallback(() => {
    halt();
    setResult(null); setError('');
  }, [halt]);

  useLayoutEffect(() => {
    const changed = desired.current.key !== position.key || enabledRef.current !== enabled;
    const wasSuspended = suspendedRef.current;
    desired.current = position;
    enabledRef.current = enabled;
    suspendedRef.current = suspended;
    if (changed) {
      paused.current = false;
      resumeAfterEdit.current = false;
      invalidate();
      launch();
    } else if (suspended && !wasSuspended) {
      resumeAfterEdit.current = searchRunning.current;
      if (searchRunning.current) halt();
    } else if (!suspended && wasSuspended && resumeAfterEdit.current) {
      resumeAfterEdit.current = false;
      launch();
    }
  }, [position.key, enabled, suspended, invalidate, halt, launch]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    let busy = false;
    const connect = () => {
      if (disposed) return;
      setConnection('connecting');
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocol}://${location.host}/ws/analysis`);
      socket.current = ws;
      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        attempt = 0;
        setConnection('connected');
        if (suspendedRef.current && !paused.current) resumeAfterEdit.current = true;
        launch();
      };
      ws.onmessage = event => {
        if (disposed || socket.current !== ws) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'hello') { setInfo(message); return; }
        if (message.code === 'busy') {
          busy = true; setConnection('busy'); setError(message.message); markRunning(false); return;
        }
        const id = activeId.current;
        const expected = desired.current;
        if (!acceptsResult(id, expected.fen, message)) return;
        if (message.multipv !== undefined && message.multipv !== expected.multipv) return;
        if (message.type === 'analysis' && acceptsAnalysis(id, expected.fen, expected.multipv, expected.legalMoves, message)) {
          setResult(previous => {
            if (activeId.current !== id || desired.current.key !== expected.key) return previous;
            return acceptsAnalysis(id, expected.fen, expected.multipv, expected.legalMoves, message, previous)
              ? {...message, ...message.candidates[0], key: expected.key} : previous;
          });
          if (message.done) markRunning(false);
        }
        if (message.type === 'complete') markRunning(false);
        if (message.type === 'error') { setError(message.message); markRunning(false); setResult(null); }
      };
      ws.onclose = () => {
        if (disposed || socket.current !== ws) return;
        activeId.current = null; markRunning(false); setResult(null);
        if (!busy) {
          setConnection('disconnected');
          setError('Analysis server disconnected. Start the backend; reconnecting automatically.');
          timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 10000));
        }
      };
      ws.onerror = () => ws.close();
    };
    timer = setTimeout(connect, 0);
    return () => {
      disposed = true; clearTimeout(timer); activeId.current = null;
      const ws = socket.current; socket.current = null;
      if (ws?.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
      else ws?.close();
    };
  }, [reconnect, launch, markRunning]);

  return {
    connection, info, error, running,
    result: enabled && result?.key === position.key ? result : null,
    invalidate,
    stop: () => { paused.current = true; halt(); },
    retry: () => { paused.current = false;
      if (connection === 'connected') launch(); else setReconnect(n => n + 1); },
  };
}
