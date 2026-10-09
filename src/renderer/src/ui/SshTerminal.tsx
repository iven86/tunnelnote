import { getRendererSettings } from './settings-store';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useId, useRef, useState } from 'react';
import type { SshHostSummary, SshSessionEvent } from '../../../shared/ssh-contract';
import { SftpPanel } from './SftpPanel';
import '@xterm/xterm/css/xterm.css';

interface SshTerminalProps {
  host: SshHostSummary;
  hidden?: boolean;
}

interface HostKeyPrompt {
  event: Extract<SshSessionEvent, { type: 'host-key' }>;
}

export function SshTerminal({ host, hidden = false }: SshTerminalProps) {
  const id = useId();
  const terminalHeadingId = `terminal-heading-${id}`;
  const hostKeyHeadingId = `host-key-heading-${id}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const connectingRef = useRef(false);
  const waitingEventsRef = useRef<SshSessionEvent[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<HostKeyPrompt | null>(null);
  const [keyboardChallenge, setKeyboardChallenge] = useState<Extract<
    SshSessionEvent,
    { type: 'keyboard-interactive' }
  > | null>(null);
  const [keyboardResponses, setKeyboardResponses] = useState<string[]>([]);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [sftpVisible, setSftpVisible] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const lifecycleGeneration = lifecycleGenerationRef.current + 1;
    lifecycleGenerationRef.current = lifecycleGeneration;
    let active = true;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: getRendererSettings().terminalFontSize,
      scrollback: getRendererSettings().terminalScrollback,
      theme: {
        background: '#101820',
        foreground: '#e7edf5',
        cursor: '#64d2c2',
        selectionBackground: '#367a7888',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    terminalRef.current = terminal;

    const inputSubscription = terminal.onData((data) => {
      const activeSessionId = sessionIdRef.current;
      if (activeSessionId) {
        void window.tunnelNote
          .sendSshInput(activeSessionId, data)
          .catch((requestError: unknown) => {
            if (active) {
              setError(errorMessage(requestError));
            }
          });
      }
    });

    let resizeScheduled = false;
    let resizeFrame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (resizeScheduled) {
        return;
      }
      resizeScheduled = true;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        resizeScheduled = false;
        if (!active) {
          return;
        }
        fit.fit();
        const activeSessionId = sessionIdRef.current;
        if (activeSessionId) {
          void window.tunnelNote
            .resizeSshTerminal(
              activeSessionId,
              clampDimension(terminal.cols, 20, 500),
              clampDimension(terminal.rows, 5, 300),
            )
            .catch((requestError: unknown) => {
              if (active) {
                setError(errorMessage(requestError));
              }
            });
        }
      });
    });
    observer.observe(container);

    const unsubscribe = window.tunnelNote.onSshEvent((event) => {
      if (!sessionIdRef.current) {
        if (
          connectingRef.current &&
          event.type !== 'output' &&
          waitingEventsRef.current.length < 16
        ) {
          waitingEventsRef.current.push(event);
        }
        return;
      }
      processEvent(event);
    });

    function processEvent(event: SshSessionEvent): void {
      if (event.sessionId !== sessionIdRef.current) {
        return;
      }
      if (event.type === 'output') {
        terminal.write(event.data);
      } else if (event.type === 'host-key') {
        setPrompt({ event });
      } else if (event.type === 'keyboard-interactive') {
        setKeyboardChallenge(event);
        setKeyboardResponses(event.prompts.map(() => ''));
      } else {
        setState(event.state);
        if (event.message) {
          setMessage(event.message);
        }
        if (event.state === 'disconnected') {
          sessionIdRef.current = null;
          setSessionId(null);
          setPrompt(null);
          setKeyboardChallenge(null);
        }
      }
    }

    return () => {
      active = false;
      lifecycleGenerationRef.current += 1;
      observer.disconnect();
      if (resizeFrame !== undefined) {
        cancelAnimationFrame(resizeFrame);
      }
      unsubscribe();
      inputSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      waitingEventsRef.current = [];
      connectingRef.current = false;
      if (sessionIdRef.current) {
        void window.tunnelNote.disconnectSsh(sessionIdRef.current).catch(() => {
          console.error('Unable to close the SSH session after its terminal was removed.');
        });
      }
      sessionIdRef.current = null;
    };
  }, [host.id]);

  useEffect(() => {
    void connect();
  }, [host.id]);

  async function connect(): Promise<void> {
    const terminal = terminalRef.current;
    if (!terminal) {
      setError('The terminal is not ready yet.');
      return;
    }
    if (connectingRef.current) {
      return;
    }
    connectingRef.current = true;
    const lifecycleGeneration = lifecycleGenerationRef.current;
    setError(null);
    setMessage(null);
    setPrompt(null);
    setKeyboardChallenge(null);
    setState('connecting');
    waitingEventsRef.current = [];
    try {
      const id = await window.tunnelNote.connectSsh(
        host.id,
        clampDimension(terminal.cols, 20, 500),
        clampDimension(terminal.rows, 5, 300),
      );
      if (lifecycleGeneration !== lifecycleGenerationRef.current) {
        try {
          await window.tunnelNote.disconnectSsh(id);
        } catch {
          console.error('Unable to close an SSH session created by a removed terminal.');
        }
        return;
      }
      sessionIdRef.current = id;
      setSessionId(id);
      const queued = waitingEventsRef.current;
      waitingEventsRef.current = [];
      for (const event of queued) {
        if (event.sessionId === id) {
          processQueuedEvent(
            event,
            terminal,
            setPrompt,
            setKeyboardChallenge,
            setKeyboardResponses,
            setState,
            setMessage,
            () => {
              sessionIdRef.current = null;
              setSessionId(null);
              setPrompt(null);
              setKeyboardChallenge(null);
              setKeyboardResponses([]);
            },
          );
        }
      }
    } catch (requestError: unknown) {
      if (lifecycleGeneration === lifecycleGenerationRef.current) {
        sessionIdRef.current = null;
        setSessionId(null);
        setState('disconnected');
        setError(errorMessage(requestError));
      }
    } finally {
      if (lifecycleGeneration === lifecycleGenerationRef.current) {
        connectingRef.current = false;
      }
    }
  }

  async function decideHostKey(approve: boolean, replaceExisting: boolean): Promise<void> {
    if (!sessionId || !prompt) {
      return;
    }
    setDecisionBusy(true);
    setError(null);
    try {
      await window.tunnelNote.decideSshHostKey(
        sessionId,
        prompt.event.decisionId,
        approve,
        replaceExisting,
      );
      setPrompt(null);
      if (!approve) {
        setMessage('SSH host key rejected.');
      } else {
        setMessage('Host key saved. Waiting for SSH authentication…');
      }
    } catch (requestError: unknown) {
      setError(errorMessage(requestError));
    } finally {
      setDecisionBusy(false);
    }
  }

  async function respondToKeyboardChallenge(responses: string[]): Promise<void> {
    if (!sessionId || !keyboardChallenge) {
      return;
    }
    setDecisionBusy(true);
    setError(null);
    try {
      await window.tunnelNote.replySshKeyboardInteractive(
        sessionId,
        keyboardChallenge.challengeId,
        responses,
      );
      setKeyboardChallenge(null);
      setKeyboardResponses([]);
    } catch (requestError: unknown) {
      setError(errorMessage(requestError));
    } finally {
      setDecisionBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    if (!sessionId) {
      return;
    }
    setError(null);
    try {
      await window.tunnelNote.disconnectSsh(sessionId);
    } catch (requestError: unknown) {
      setError(errorMessage(requestError));
    }
  }

  return (
    <section aria-labelledby={terminalHeadingId} className="terminal-panel" hidden={hidden}>
      <div className="terminal-bar">
        <span aria-live="polite" className={`connection-state state-${state}`}>
          ● {state}
        </span>
        <span className="terminal-bar-title" id={terminalHeadingId}>
          {host.username}@{host.hostname}:{host.port}
        </span>
        <div className="button-row">
          {state === 'disconnected' ? (
            <button disabled={Boolean(sessionId)} onClick={() => void connect()} type="button">
              {message ? 'Reconnect' : 'Connect'}
            </button>
          ) : (
            <button className="secondary-button" onClick={() => void disconnect()} type="button">
              Disconnect
            </button>
          )}
          {state === 'connected' ? (
            <button
              className="secondary-button"
              onClick={() => setSftpVisible((visible) => !visible)}
              type="button"
            >
              {sftpVisible ? 'Hide SFTP' : 'SFTP'}
            </button>
          ) : null}
        </div>
      </div>

      {prompt ? (
        <div aria-labelledby={hostKeyHeadingId} className="host-key-prompt" role="alert">
          <h3 id={hostKeyHeadingId}>
            {prompt.event.previousFingerprint ? 'SSH host key changed' : 'Trust this SSH host?'}
          </h3>
          <p>
            {prompt.event.hostname}:{prompt.event.port}
          </p>
          {prompt.event.previousFingerprint ? (
            <p className="status-error">
              Previously trusted: <code>{prompt.event.previousFingerprint}</code>
            </p>
          ) : null}
          <p className="fingerprint">
            SHA256 fingerprint: <code>{prompt.event.fingerprint}</code>
          </p>
          <pre aria-label="SSH host-key randomart" className="randomart">
            {prompt.event.randomart}
          </pre>
          <p className="hint">
            Verify this fingerprint with the server administrator before trusting it.
          </p>
          <div className="button-row">
            <button
              disabled={decisionBusy}
              onClick={() => void decideHostKey(true, Boolean(prompt.event.previousFingerprint))}
              type="button"
            >
              {prompt.event.previousFingerprint
                ? 'Replace trusted key and connect'
                : 'Trust key and connect'}
            </button>
            <button
              className="secondary-button"
              disabled={decisionBusy}
              onClick={() => void decideHostKey(false, false)}
              type="button"
            >
              Reject
            </button>
          </div>
        </div>
      ) : null}

      {keyboardChallenge ? (
        <form
          className="keyboard-interactive-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            void respondToKeyboardChallenge(keyboardResponses);
          }}
        >
          <h3>{keyboardChallenge.name || 'SSH authentication required'}</h3>
          {keyboardChallenge.instructions ? <p>{keyboardChallenge.instructions}</p> : null}
          {keyboardChallenge.prompts.map((item, index) => (
            <label className="challenge-field" key={`${item.text}-${index}`}>
              <span>{item.text}</span>
              <input
                autoComplete="off"
                maxLength={4096}
                onChange={(event) =>
                  setKeyboardResponses((current) =>
                    current.map((response, responseIndex) =>
                      responseIndex === index ? event.target.value : response,
                    ),
                  )
                }
                type={item.echo ? 'text' : 'password'}
                value={keyboardResponses[index] ?? ''}
              />
            </label>
          ))}
          <div className="button-row">
            <button disabled={decisionBusy} type="submit">
              Submit authentication response
            </button>
            <button
              className="secondary-button"
              disabled={decisionBusy}
              onClick={() => void respondToKeyboardChallenge([])}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div aria-label="SSH terminal output" className="terminal-container" ref={containerRef} />
      {sessionId && state === 'connected' ? (
        <SftpPanel hidden={!sftpVisible} sessionId={sessionId} />
      ) : null}
      {message ? (
        <p className="status" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="status status-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function processQueuedEvent(
  event: SshSessionEvent,
  terminal: Terminal,
  setPrompt: (prompt: HostKeyPrompt | null) => void,
  setKeyboardChallenge: (
    challenge: Extract<SshSessionEvent, { type: 'keyboard-interactive' }> | null,
  ) => void,
  setKeyboardResponses: (responses: string[]) => void,
  setState: (state: 'disconnected' | 'connecting' | 'connected') => void,
  setMessage: (message: string | null) => void,
  clearSession: () => void,
): void {
  if (event.type === 'output') {
    terminal.write(event.data);
  } else if (event.type === 'host-key') {
    setPrompt({ event });
  } else if (event.type === 'keyboard-interactive') {
    setPrompt(null);
    setKeyboardChallenge(event);
    setKeyboardResponses(event.prompts.map(() => ''));
  } else {
    setState(event.state);
    if (event.message) {
      setMessage(event.message);
    }
    if (event.state === 'disconnected') {
      clearSession();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The SSH operation failed.';
}

function clampDimension(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
