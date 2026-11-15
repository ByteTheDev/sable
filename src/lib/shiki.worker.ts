/**
 * Syntax highlighting off the main thread. The grammar engine runs regexes for every line of
 * every block; in a worker a long diff can take its time without ever blocking a frame.
 */
import { tokenize } from './shiki';

interface Request {
  id: number;
  code: string;
  lang: string;
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage: (msg: unknown) => void };

scope.onmessage = async (e) => {
  const { id, code, lang } = e.data;
  let lines = null;
  try {
    lines = await tokenize(code, lang);
  } catch {
    /* reported as no tokens: the block stays plain */
  }
  scope.postMessage({ id, lines });
};
