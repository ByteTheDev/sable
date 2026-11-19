import { useState, type FormEvent } from 'react';
import type { ProviderId } from '@shared/protocol';
import { submitLoginCode } from '@/state/actions';
import { Spinner } from '@/ui';

/**
 * A sign-in whose browser page shows a code instead of returning to Sable (Claude Code's
 * "paste this code" page): the code goes here and finishes the sign-in in progress.
 */
export function LoginCode({ provider, accountId, codeUrl }: { provider: ProviderId; accountId?: string; codeUrl?: string }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    const res = await submitLoginCode(provider, accountId, code);
    setBusy(false);
    if (!res?.ok) setError(res?.error ?? 'The code did not work. Start the sign-in again.');
  };

  return (
    <form className="login-code" onSubmit={submit}>
      <input
        className="field login-code-input"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Code from the browser"
        aria-label="Code from the browser"
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        autoComplete="off"
      />
      {/* The page that shows a code works on any device or browser, also when the return to Sable cannot. */}
      {codeUrl && !code.trim() && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => window.open(codeUrl, '_blank', 'noopener')}>
          Get a code
        </button>
      )}
      <button type="submit" className="btn btn-sm" disabled={!code.trim() || busy}>
        {busy && <Spinner size={13} />}
        Continue
      </button>
      {error && <p className="login-code-error">{error}</p>}
    </form>
  );
}
